# -*- coding: utf-8 -*-
"""问 WhaleLife 一句话，拿一句话回来。

只用标准库（urllib），不引入 request/aiohttp —— ComfyUI 那边的依赖已经够多，
为一条 HTTP 再欠一个包不值。

两条边界：

1. 宿主在插件路由之前卡登录 cookie，所以这里必须两步：
   POST /api/login 拿 Set-Cookie，再带 cookie 打插件路由。
   访问密码为空时 body 传 {} 就够；设了密码就填进 config.json 的 password。

2. cookie 是宿主进程内的一串随机 token，宿主一重启就失效。
   所以第一次 401 的时候自动重登一次，别让用户手动去清缓存。
"""
import json
import urllib.error
import urllib.request
import http.cookiejar

DEFAULT_BASE = "http://127.0.0.1:9270"
DEFAULT_ROUTE = "/plugins/comfy/ask"
LOGIN_ROUTE = "/api/login"


class WhaleLifeError(RuntimeError):
    pass


class WhaleLifeClient:
    """一个够用的客户端：登录一次，之后复用 cookie。"""

    def __init__(self, base=DEFAULT_BASE, password="", token="", timeout=180):
        self.base = str(base or DEFAULT_BASE).rstrip("/")
        self.password = password or ""
        self.token = token or ""
        self.timeout = max(5, int(timeout or 180))
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar)
        )
        self._logged = False

    # --- 内部 ---
    def _post(self, path, payload, with_token=False):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if with_token and self.token:
            headers["Authorization"] = "Bearer " + self.token
        req = urllib.request.Request(self.base + path, data=body, headers=headers, method="POST")
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", "replace")
            try:
                return error.code, json.loads(raw or "{}")
            except Exception:
                return error.code, {"ok": False, "error": raw[:400]}
        except urllib.error.URLError as error:
            raise WhaleLifeError(
                "连不上 %s：%s。宿主起来了吗？端口对吗？" % (self.base, error.reason)
            )

    def login(self):
        status, data = self._post(LOGIN_ROUTE, {"password": self.password})
        if status != 200 or not data.get("ok"):
            raise WhaleLifeError(
                "登录失败（HTTP %s）：%s" % (status, data.get("error") or "宿主访问密码可能设了")
            )
        self._logged = True

    # --- 对外 ---
    def ask(self, text, session="", persona="", timeout=None, mode=""):
        if not self._logged:
            self.login()
        payload = {"text": text}
        if session:
            payload["session"] = session
        if persona:
            payload["persona"] = persona
        if timeout:
            payload["timeout_ms"] = int(timeout) * 1000
        # 面板上那枚「同步到主对话」的开关：persistent 进历史，transient 不进。
        # 空串 = 不表态，由插件那边的配置决定。
        if mode:
            payload["mode"] = str(mode)

        status, data = self._post(DEFAULT_ROUTE, payload, with_token=True)
        # cookie 过期（宿主重启过）就重登一次，不算失败。
        if status == 401 and not data.get("error", "").startswith("令牌"):
            self.login()
            status, data = self._post(DEFAULT_ROUTE, payload, with_token=True)

        if status != 200 or not data.get("ok"):
            raise WhaleLifeError(
                "WhaleLife 没回话（HTTP %s）：%s" % (status, data.get("error") or "原因不明")
            )
        return str(data.get("reply") or "")

    def status(self):
        req = urllib.request.Request(self.base + "/plugins/comfy/chat-status", method="GET")
        try:
            with self._opener.open(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as error:
            if error.code == 401:
                self.login()
                with self._opener.open(req, timeout=15) as resp:
                    return json.loads(resp.read().decode("utf-8") or "{}")
            raise WhaleLifeError("查状态失败（HTTP %s）" % error.code)
