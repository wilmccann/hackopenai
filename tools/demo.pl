#!/usr/bin/env perl
# HackyTab demo launcher: opens Google Chrome with a throwaway profile, loads
# the extension from this repo, and opens the demo tab set (demo/tabs.json)
# in a fresh window. Re-run it any time for a clean starting point.
#
#   tools/demo.pl                 # or: tools/demo.sh
#   tools/demo.pl --keep-profile  # keep the scratch profile after Chrome quits
#
# Chrome 137+ ignores --load-extension in the branded build, so the extension is
# installed with the DevTools command Extensions.loadUnpacked over a private
# debugging pipe (fds 3 and 4). No TCP debugging port is opened (SECURITY.md).
# The demo window itself is opened by the extension's own demo/open-demo.js,
# which also discards the tabs marked "stale" so they count as stale (F12) and
# arms the window so the prompt fires after two more tabs (spec section 11).
#
# The scratch profile is deleted when Chrome quits or on Ctrl+C. It holds
# whatever the extension stored, including an API key pasted into Settings.
use strict; use warnings;
$| = 1;
use File::Basename qw(dirname);
use File::Spec;
use File::Temp qw(tempdir);
use File::Path qw(remove_tree);
use POSIX qw(dup2 :sys_wait_h);
use JSON::PP;

my $KEEP = grep { $_ eq '--keep-profile' } @ARGV;
my $ROOT = File::Spec->rel2abs(File::Spec->catdir(dirname(__FILE__), '..'));
my $CHROME = $ENV{CHROME} || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
die "Chrome not found at $CHROME (set CHROME=/path/to/chrome)\n" unless -x $CHROME;
die "manifest.json not found in $ROOT\n" unless -f "$ROOT/manifest.json";

my $SCRATCH = tempdir('hackytab-demo-XXXXXX', TMPDIR => 1);
chmod 0700, $SCRATCH;
my $PROFILE = "$SCRATCH/profile";
print "profile: $PROFILE (deleted on exit unless --keep-profile)\n";

# Pipes: Chrome reads DevTools commands on fd 3 and writes responses on fd 4.
pipe(my $cin_r, my $cin_w) or die "pipe: $!";
pipe(my $cout_r, my $cout_w) or die "pipe: $!";
my $pid = fork; die "fork: $!" unless defined $pid;
if ($pid == 0) {
  # The pipe handles may already sit on fds 3/4 with close-on-exec set; go via
  # fresh dups (no close-on-exec) so the numbers Chrome expects survive exec.
  my ($r3, $w4) = (POSIX::dup(fileno $cin_r), POSIX::dup(fileno $cout_w));
  dup2($r3, 3) or die "dup2: $!";
  dup2($w4, 4) or die "dup2: $!";
  open STDOUT, '>', "$SCRATCH/chrome.log"; open STDERR, '>&', \*STDOUT;
  exec $CHROME, "--user-data-dir=$PROFILE", '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging', '--no-first-run',
    '--no-default-browser-check', 'about:blank' or die "exec: $!";
}
close $cin_r; close $cout_w;
$cin_w->autoflush(1);

my $json = JSON::PP->new->utf8->canonical;
my $buf = ''; my $next_id = 0;
sub call {
  my ($method, $params, $session) = @_;
  my $id = ++$next_id;
  my %msg = (id => $id, method => $method, params => $params || {});
  $msg{sessionId} = $session if $session;
  syswrite($cin_w, $json->encode(\%msg) . "\0") or die "write: $!";
  my $deadline = time + 30;
  while (time < $deadline) {
    while ((my $i = index($buf, "\0")) >= 0) {
      my $raw = substr($buf, 0, $i, ''); substr($buf, 0, 1, '');
      my $m = $json->decode($raw);
      next unless defined $m->{id} && $m->{id} == $id;
      die "$method failed: $m->{error}{message}\n" if $m->{error};
      return $m->{result};
    }
    my $n = sysread($cout_r, $buf, 65536, length $buf);
    die "Chrome closed the debugging pipe\n" unless $n;
  }
  die "$method timed out\n";
}

sub cleanup {
  if (waitpid($pid, WNOHANG) == 0) { kill 'TERM', $pid; for (1..50) { last if waitpid($pid, WNOHANG); select undef, undef, undef, 0.2 } kill 'KILL', $pid if waitpid($pid, WNOHANG) == 0 }
  if ($KEEP) { print "profile kept at $PROFILE - it may contain API keys; delete it when done\n" }
  else { remove_tree($SCRATCH) }
}
$SIG{INT} = $SIG{TERM} = sub { cleanup(); exit 0 };

# 1. Install the unpacked extension.
my $ext = call('Extensions.loadUnpacked', { path => $ROOT })->{id};
print "extension loaded: $ext\n";

# 2. Ask the extension to open the demo window by calling the worker's dev
#    hook (globalThis.openDemo in background.js) in the service worker target.
#    The worker only honors runtime messages from its own side panel page, so
#    a helper tab cannot be used; the debugging pipe is the one other way in.
my $worker;
for my $try (1..40) {
  ($worker) = grep { $_->{type} eq 'service_worker' && $_->{url} eq "chrome-extension://$ext/background.js" }
    @{ call('Target.getTargets')->{targetInfos} };
  last if $worker;
  select undef, undef, undef, 0.25;
}
die "extension service worker did not start\n" unless $worker;
my $session = call('Target.attachToTarget', { targetId => $worker->{targetId}, flatten => JSON::PP::true })->{sessionId};
my $res;
for my $try (1..10) {
  my $r = call('Runtime.evaluate', {
    expression => 'typeof openDemo === "function" ? openDemo().catch(e => ({ error: String(e) })) : { error: "openDemo not defined yet" }',
    awaitPromise => JSON::PP::true, returnByValue => JSON::PP::true }, $session);
  $res = $r->{result}{value};
  print STDERR "attempt $try: " . $json->encode($r) . "\n" if $ENV{DEMO_DEBUG};
  last if ref $res && $res->{ok};
  select undef, undef, undef, 0.5;
}
die "openDemo failed: " . ($res && $res->{error} ? $res->{error} : 'no response') . "\n" unless ref $res && $res->{ok};
print "demo window $res->{windowId} opened with $res->{count} tabs\n";

# 3. Close the initial blank window so only the demo window remains.
for my $t (@{ call('Target.getTargets')->{targetInfos} }) {
  call('Target.closeTarget', { targetId => $t->{targetId} }) if $t->{type} eq 'page' && $t->{url} eq 'about:blank';
}
print "Ready. Open two more tabs in the demo window to trigger the prompt (badge + toast).\nCtrl+C or quit Chrome to finish; the profile is then deleted.\n";

# 4. Keep the pipe open until Chrome exits (closing the pipe would quit Chrome).
while (waitpid($pid, WNOHANG) == 0) { sleep 1 }
cleanup(); exit 0;
