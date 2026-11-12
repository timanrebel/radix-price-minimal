"""Exercise the local Worker with the same price fixtures as the Python service."""

import concurrent.futures
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import sys

repo = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(repo))
from test_minprice import Mock, TOKENS, XRD, LSU

class CountingMock(Mock):
    calls = []
    fail_cycle = False

    def do_POST(self):
        self.calls.append(self.path)
        if self.fail_cycle and self.path == "/status/gateway-status":
            self.rfile.read(int(self.headers["Content-Length"]))
            return self._send({}, 429)
        return super().do_POST()

def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        for name in ["src", "migrations"]:
            shutil.copytree(repo / name, root / name)
        (root / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
        (root / "tokens.json").write_text(json.dumps(TOKENS))
        shutil.copy(repo / "wrangler.jsonc", root)
        exe = str(repo / "node_modules/.bin/wrangler")
        subprocess.run([exe, "d1", "migrations", "apply", "DB", "--local"], cwd=root, check=True)
        mock = ThreadingHTTPServer(("127.0.0.1", 0), CountingMock)
        threading.Thread(target=mock.serve_forever, daemon=True).start()
        gateway = "http://127.0.0.1:" + str(mock.server_port)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = "http://127.0.0.1:" + str(port)
        logpath = root / "dev.log"

        def call(path, data=None, headers=None):
            req = Request(base + path, data=data, headers=headers or {})
            try:
                res = urlopen(req, timeout=10)
            except HTTPError as e:
                res = e
            with res:
                body = res.read()
                try:
                    body = json.loads(body)
                except ValueError:
                    body = body.decode()
                return res.status, body

        def post(path, body, headers=None):
            return call(path, json.dumps(body).encode(), {"Content-Type": "application/json", **(headers or {})})

        key = {"x-api-key": "local-key"}
        ts = int(time.time())
        with logpath.open("w") as log:
            proc = subprocess.Popen([exe, "dev", "--test-scheduled", "--port", str(port),
                                     "--var", "GATEWAY_URL:" + gateway, "--var", "COINGECKO_URL:" + gateway + "/cg",
                                     "--var", "API_KEY:local-key", "--var", "PRICE_CACHE_SECS:0"],
                                    cwd=root, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        health = call("/healthz")
                        break
                    except URLError:
                        if proc.poll() is not None:
                            raise RuntimeError("Wrangler exited before starting")
                        time.sleep(0.2)
                else:
                    raise RuntimeError("Wrangler did not start in time")
                assert health == (503, {"Everything": "Stale", "last_cycle_age_secs": None, "last_error": None, "tokens": 0}), health
                assert call("/latest")[0] == 404
                code, body = call("/__scheduled?cron=*+*+*+*+*")
                assert code == 200, (code, body)
                for _ in range(30):
                    health = call("/healthz")
                    if health[0] == 200:
                        break
                    time.sleep(0.1)
                assert health[0] == 200 and health[1]["tokens"] == 6, health
                calls_before = len(CountingMock.calls)
                request = {"currency": "usd", "tokens": [XRD, "resource_foo", "nope", XRD]}
                code, prices = post("/price/tokens?ignored=1", request)
                assert code == 200 and [t["resource_address"] for t in prices["tokens"]] == [XRD, "resource_foo"], prices
                assert abs(prices["tokens"][0]["usd_price"] - 0.02) < 1e-9
                assert abs(prices["tokens"][1]["usd_price"] - 2) < 1e-9
                assert post("/price/tokens-legacy/", request) == (200, prices)
                code, listed = call("/tokens", b"ignored")
                assert code == 200 and [t["symbol"] for t in listed] == ["XRD", "hUSDC", "FOO", "hETH", "DFP2", "ZAP"], listed
                zap = listed[-1]["price"]
                assert abs(zap - 0.04) < 0.00004, zap
                assert len(CountingMock.calls) == calls_before, CountingMock.calls
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                    results = list(pool.map(lambda i: post("/price/tokens", {
                        **request, "lsus": [LSU, "resource_other_" + str(i)]}), range(8)))
                for code, result in results:
                    assert code == 200 and len(result["lsus"]) == 1, result
                    assert abs(result["lsus"][0]["usd_price"] - 0.022) < 1e-9
                assert CountingMock.calls.count("/state/entity/details") == 9, CountingMock.calls
                assert post("/price/tokens-legacy", {**request, "lsus": [LSU]})[1]["lsus"] == results[0][1]["lsus"]
                assert CountingMock.calls.count("/state/entity/details") == 9
                path = "/price/historicalPrice"
                query = {"tokens": [XRD], "timestamp": ts}
                assert post(path, query)[0] == 401
                code, history = post(path + "-legacy", query, key)
                assert code == 200 and abs(history["prices"][XRD]["usd_price"] - 0.02) < 1e-9, history
                assert post(path, query, key) == (200, history)
                assert post(path, {**query, "timestamp": float(ts)}, key)[0] == 400
                assert post(path, {**query, "timestamp": ts - 10 * 86400}, key)[0] == 424
                assert post(path, {**query, "tokens": [XRD, "missing"]}, key) == (424, {"detail": "Price missing for tokens: missing"})
                assert post("/price/tokens", {"currency": "EUR"})[0] == 400
                assert post("/price/tokens", {"currency": "usd", "tokens": "wrong"})[0] == 422
                assert post("/price/tokens", {"currency": "usd", "tokens": ["x"] * 501})[0] == 422
                assert call("/price/tokens", b"?" * (256 * 1024 + 1))[0] == 413
                CountingMock.fail_cycle = True
                code, body = call("/__scheduled?cron=*+*+*+*+*")
                assert code == 500, (code, body)
                assert "429" in call("/healthz")[1]["last_error"]
                assert post("/price/tokens", request) == (200, prices)
                print("Worker integration passed: cron, pricing, history and auth, LSU coalescing, validation and failure recovery")
            except Exception:
                print(logpath.read_text(), file=sys.stderr)
                raise
            finally:
                proc.terminate()
                try:
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                mock.shutdown()
                mock.server_close()


if __name__ == "__main__":
    main()
