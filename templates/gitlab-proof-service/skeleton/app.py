"""${{ values.name }}: a tiny HTTP service for the GitLab proof (box1-docs#164)."""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

MESSAGE = "Hello from ${{ values.name }}"


def info():
    return {"service": "${{ values.name }}", "message": MESSAGE,
            "revision": os.environ.get("SOURCE_REVISION", "unknown")}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            body, code = {"status": "ok"}, 200
        elif self.path == "/":
            body, code = info(), 200
        else:
            body, code = {"error": "not found"}, 404
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
