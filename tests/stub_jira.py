import base64, json, re, sys, time
from urllib.parse import urlparse, parse_qs
DELAY = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 0
# Optional fixture file (argv[4]): {"issues": {KEY: {...fields...}}, "children": {KEY: [KEY, ...]},
# "page_size": n, "link_readback": "normal"|"drop", "remotelinks": {KEY: [...]}, "remotelink_fail": [KEY]}. Issue links posted are kept in memory, on both
# issues, the way Jira shows them: the other side, from each issue's point of view.
FIX = {"issues": {}, "children": {}}
if len(sys.argv) > 4:
    with open(sys.argv[4]) as f:
        FIX = json.load(f)
from http.server import BaseHTTPRequestHandler, HTTPServer
GOOD = "Basic " + base64.b64encode(b"me@example.com:good-token").decode()
LOG = sys.argv[2]
BLOCKS = {"name": "Blocks", "inward": "is blocked by", "outward": "blocks"}
NEXT_ID = [10000]

def issue(key):
    i = FIX["issues"].get(key)
    if i is None:
        return None
    f = dict(i)
    f.setdefault("summary", key)
    f.setdefault("status", {"name": "To Do", "statusCategory": {"key": "new"}})
    f.setdefault("issuetype", {"name": "Task", "subtask": False, "hierarchyLevel": 0})
    f.setdefault("issuelinks", [])
    return {"key": key, "fields": f, "names": i.get("_names", {})}

def brief(key):
    i = issue(key)
    return {"key": key, "fields": {k: i["fields"][k] for k in ("summary", "status", "issuetype")}} if i else {"key": key}

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
        path = urlparse(self.path).path
        if path.startswith("/rest/api/3/myself"):
            time.sleep(DELAY)
            return self._send(200, {"accountId": "abc", "displayName": "Me", "emailAddress": "me@example.com"}) if authed else self._send(401, {"errorMessages": ["unauthorized"]})
        if path.startswith("/rest/api/3/search/jql"):
            if not authed:
                return self._send(200, {"issues": []})  # Jira's anonymous behaviour
            body = json.loads(data or "{}")
            m = re.match(r"\s*parent\s*=\s*([A-Z][A-Z0-9]*-[0-9]+)", body.get("jql", ""))
            if m:
                kids = FIX["children"].get(m.group(1), [])
                size = FIX.get("page_size") or body.get("maxResults") or 50
                start = int(body.get("nextPageToken") or 0)
                page = [issue(k) for k in kids[start:start + size] if issue(k)]
                res = {"issues": page, "isLast": start + size >= len(kids)}
                if not res["isLast"]:
                    res["nextPageToken"] = str(start + size)
                return self._send(200, res)
            return self._send(200, {"issues": [{"key": "KAN-1", "fields": {"summary": "s", "status": {"name": "To Do"}, "priority": {"name": "High"}}}]})
        m = re.match(r"/rest/api/[23]/issue/([A-Z][A-Z0-9]*-[0-9]+)/remotelink$", path)
        if m and self.command == "GET":
            if not authed or m.group(1) in FIX.get("remotelink_fail", []):
                return self._send(500, {"errorMessages": ["remote links unavailable"]})
            return self._send(200, FIX.get("remotelinks", {}).get(m.group(1), []))
        m = re.match(r"/rest/api/[23]/issue/([A-Z][A-Z0-9]*-[0-9]+)$", path)
        if m and self.command == "GET":
            if not authed:
                return self._send(404, {"errorMessages": ["nope"]})
            i = issue(m.group(1))
            return self._send(200, i) if i else self._send(404, {"errorMessages": ["Issue does not exist"]})
        if path in ("/rest/api/3/issueLink", "/rest/api/2/issueLink") and self.command == "POST":
            body = json.loads(data or "{}")
            inward, outward = body["inwardIssue"]["key"], body["outwardIssue"]["key"]
            # "inward blocks outward": outward shows "is blocked by inward" (an inwardIssue entry),
            # inward shows "blocks outward" (an outwardIssue entry).
            if FIX.get("link_readback") != "drop":
                NEXT_ID[0] += 1
                FIX["issues"].setdefault(outward, {}).setdefault("issuelinks", []).append(
                    {"id": str(NEXT_ID[0]), "type": BLOCKS, "inwardIssue": brief(inward)})
                FIX["issues"].setdefault(inward, {}).setdefault("issuelinks", []).append(
                    {"id": str(NEXT_ID[0]), "type": BLOCKS, "outwardIssue": brief(outward)})
            return self._send(201, {})
        if path == "/rest/api/2/issue" and self.command == "POST":
            # Kept so a read-back sees it; only the stub's own account resolves to a display name.
            f = dict(json.loads(data or "{}").get("fields", {}))
            a = f.get("assignee")
            f["assignee"] = dict(a, displayName="Me") if isinstance(a, dict) and a.get("accountId") == "abc" else a
            FIX["issues"]["KAN-99"] = f
            return self._send(201, {"id": "1", "key": "KAN-99"})
        if "/comment" in self.path and self.command == "POST":
            return self._send(201, {"id": "10"})
        self._send(404, {"errorMessages": ["nope"]})
    do_GET = do_POST = do_PUT = handle_any
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
