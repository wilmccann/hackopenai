#!/usr/bin/env python3
# Run the extension in Google Chrome from the command line.
#
# Chrome 137+ ignores --load-extension in the branded build ("--load-extension is
# not allowed in Google Chrome, ignoring"). The supported replacement is the
# DevTools command Extensions.loadUnpacked over a debugging pipe, which needs
# --enable-unsafe-extension-debugging. This script does exactly that with a
# throwaway profile, then keeps the pipe open so Chrome stays up. Ctrl+C quits.
#
#   python3 tools/run-chrome.py            # loads this repo
#   python3 tools/run-chrome.py /other/ext # loads another folder
#
# Manual alternative: chrome://extensions, Developer mode, Load unpacked.
import tempfile, pathlib
EXT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else str(pathlib.Path(__file__).resolve().parent.parent)
S = tempfile.mkdtemp(prefix="hackytab-chrome-")
P = os.path.join(S, "profile")
print("profile:", P, flush=True)
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
r_in, w_in = os.pipe()    # chrome reads fd 3
r_out, w_out = os.pipe()  # chrome writes fd 4
w_in_keep, r_out_keep = os.dup(w_in), os.dup(r_out)
os.dup2(r_in, 3); os.dup2(w_out, 4)
args = [CHROME, f"--user-data-dir={P}", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
        "--remote-debugging-port=9333", "--no-first-run", "--no-default-browser-check", "chrome://extensions"]
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
open(f"{S}/loaded.json", "w").write(json.dumps(res))
print("loadUnpacked:", json.dumps(res), flush=True)
signal.signal(signal.SIGTERM, lambda *a: (proc.terminate(), sys.exit(0)))
while proc.poll() is None: time.sleep(1)
