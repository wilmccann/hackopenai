#!/usr/bin/env python3
# Run the extension in Google Chrome from the command line.
#
# Chrome 137+ ignores --load-extension in the branded build ("--load-extension is
# not allowed in Google Chrome, ignoring"). The supported replacement is the
# DevTools command Extensions.loadUnpacked over a debugging pipe, which needs
# --enable-unsafe-extension-debugging. This script does exactly that with a
# throwaway profile, then keeps the pipe open so Chrome stays up. Ctrl+C quits.
#
#   python3 tools/run-chrome.py                 # loads this repo
#   python3 tools/run-chrome.py /other/ext      # loads another folder
#   python3 tools/run-chrome.py --keep-profile  # do not delete the profile on exit
#
# Security notes (see docs/SECURITY.md):
#   - The DevTools connection is a private pipe (fds 3 and 4) owned by this
#     process only. Do NOT add --remote-debugging-port: a TCP debugging port
#     lets any local process attach to the browser, open extension pages, and
#     read chrome.storage.local, which holds the API keys.
#   - The scratch profile holds everything the extension stores, including any
#     API key pasted into Settings. It is deleted when this script exits
#     (Ctrl+C, SIGTERM, or Chrome quitting). Pass --keep-profile to keep it, and
#     delete it yourself afterwards.
#
# Manual alternative: chrome://extensions, Developer mode, Load unpacked.
import atexit, json, os, pathlib, shutil, signal, subprocess, sys, tempfile, time

args_in = [a for a in sys.argv[1:] if not a.startswith("--")]
KEEP_PROFILE = "--keep-profile" in sys.argv
EXT = os.path.abspath(args_in[0]) if args_in else str(pathlib.Path(__file__).resolve().parent.parent)
S = tempfile.mkdtemp(prefix="hackytab-chrome-")
os.chmod(S, 0o700)
P = os.path.join(S, "profile")
print("profile:", P, "(deleted on exit unless --keep-profile)", flush=True)
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

proc = None

def cleanup():
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
    if KEEP_PROFILE:
        print("profile kept at", P, "- it may contain API keys; delete it when done", flush=True)
    else:
        shutil.rmtree(S, ignore_errors=True)

atexit.register(cleanup)
signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
signal.signal(signal.SIGINT, lambda *a: sys.exit(0))

r_in, w_in = os.pipe()    # chrome reads fd 3
r_out, w_out = os.pipe()  # chrome writes fd 4
w_in_keep, r_out_keep = os.dup(w_in), os.dup(r_out)
os.dup2(r_in, 3); os.dup2(w_out, 4)
args = [CHROME, f"--user-data-dir={P}", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
        "--no-first-run", "--no-default-browser-check", "chrome://extensions"]
proc = subprocess.Popen(args, pass_fds=(3, 4), stdout=open(f"{S}/chrome.log", "wb"), stderr=subprocess.STDOUT)
os.close(3); os.close(4)

def send(mid, method, params):
    os.write(w_in_keep, (json.dumps({"id": mid, "method": method, "params": params}) + "\0").encode())
def recv(mid, timeout=30):
    buf = b""; end = time.time() + timeout
    while time.time() < end:
        chunk = os.read(r_out_keep, 65536)
        if not chunk: raise SystemExit("pipe closed")
        buf += chunk
        while b"\0" in buf:
            msg, buf = buf.split(b"\0", 1)
            m = json.loads(msg)
            if m.get("id") == mid: return m
    raise SystemExit("timeout")

send(1, "Extensions.loadUnpacked", {"path": EXT})
res = recv(1)
print("loadUnpacked:", json.dumps(res), flush=True)
while proc.poll() is None: time.sleep(1)
