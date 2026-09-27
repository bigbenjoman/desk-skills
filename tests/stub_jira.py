import base64, json, sys, time
DELAY = float(sys.argv[3]) if len(sys.argv) > 3 else 0
from http.server import BaseHTTPRequestHandler, HTTPServer
GOOD = "Basic " + base64.b64encode(b"me@example.com:good-token").decode()
LOG = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def handle_any(self):
        n = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        authed = self.headers.get("Authorization") == GOOD
        with open(LOG, "a") as f:
            f.write(json.dumps({"path": self.path, "method": self.command, "authed": authed, "body": data}) + "\n")
        if self.path.startswith("/rest/api/3/myself"):
            time.sleep(DELAY)
            return self._send(200, {"accountId": "abc", "displayName": "Me", "emailAddress": "me@example.com"}) if authed else self._send(401, {"errorMessages": ["unauthorized"]})
        if self.path.startswith("/rest/api/3/search/jql"):
            if not authed:
                return self._send(200, {"issues": []})  # Jira's anonymous behaviour
            return self._send(200, {"issues": [{"key": "KAN-1", "fields": {"summary": "s", "status": {"name": "To Do"}, "priority": {"name": "High"}}}]})
        if "/comment" in self.path and self.command == "POST":
            return self._send(201, {"id": "10"})
        self._send(404, {"errorMessages": ["nope"]})
    do_GET = do_POST = do_PUT = handle_any
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
