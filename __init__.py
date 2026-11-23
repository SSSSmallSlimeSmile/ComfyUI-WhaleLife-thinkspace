# -*- coding: utf-8 -*-
"""把 ComfyUI 的当前工作流导出成「思维画布」能直接导入的功能。

三件事想清楚才这么写：

1. 不碰 ComfyUI 界面代码。走它自己的扩展机制：一条 HTTP 路由 + 一个小脚本。
   升级 ComfyUI 不会把这里冲掉。

2. 浏览器不直接找画布。画布代理只认自己那个 origin，从 8188 发过去的请求会被
   拦掉——放宽它等于拆防护。所以这里由 Python 落盘，画布那边再读文件。
   两边谁也不认识谁，各写各的。

3. 一次导出两个文件，各有用处：
   - <target>/workflows/<slug>.json        ComfyUI 的 API 格式，comfy_generate 靠它跑
   - <target>/canvas-flows/<slug>.json     画布的功能包（schemaVersion 1），拖进去就能用
   两个文件同名不同目录，改了哪个都一眼认得出。

4. 目标可以有好几个（两台 WhaleLife、一台日常一台纯净）。写的时候每个都写，
   省得为"导到哪台"来回改配置；一个都不在就明确报错，别静默成功。
"""
import hashlib
import json
import re
import time
from pathlib import Path

from aiohttp import web

HERE = Path(__file__).parent
CONFIG = HERE / "config.json"
EXAMPLE = HERE / "config.example.json"

DEFAULTS = {
    # 一台机器可以有多份 WhaleLife。每个元素都是「comfy 插件的目录」，
    # 也就是 .../WhaleLife/plugins/comfy 这一层。
    "targets": [],
    "workflows": "workflows",
    "canvasFlows": "canvas-flows",
    "allowOverwrite": False,
}

SLUG = re.compile(r"[^0-9A-Za-z_\-一-鿿]+")
# 画布那边对 id 的要求：^[A-Za-z0-9_-]{1,80}$，这里留出余量。
MAX_SLUG = 60


def _read_raw():
    try:
        data = json.loads(CONFIG.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def load_config():
    """配置坏了就退回默认，不要让导出因为一个逗号全废。"""
    data = _read_raw()
    merged = dict(DEFAULTS)
    merged.update({k: v for k, v in data.items() if k in DEFAULTS})
    # 旧版写的是单数 target，兼容一下：谁升级上来的都还能用。
    legacy = data.get("target")
    if not merged["targets"] and isinstance(legacy, str) and legacy.strip():
        merged["targets"] = [legacy.strip()]
    merged["targets"] = [str(t).strip() for t in merged["targets"] if str(t).strip()]
    return merged


def slugify(name):
    """文件名：保留中文，别的都换成短横。

    Windows 允许中文文件名，而 comfy_generate 只按名字找文件，所以没必要
    把名字洗成一串没意义的 ascii——用户在工作流下拉里认得出哪个是哪个。
    """
    text = SLUG.sub("-", str(name or "").strip()).strip("-_")
    return (text[:MAX_SLUG] or "comfy-flow")


def flow_id_for(stem):
    """画布那边的 id 只认 [A-Za-z0-9_-]，中文得转。

    有 ascii 就用 ascii；全中文就取名字的哈希前缀——同一个名字永远得到
    同一个 id，重导一次是覆盖而不是多一份。
    """
    token = re.sub(r"[^0-9A-Za-z_-]+", "-", stem).strip("-_")[:40]
    if token:
        return "comfy-" + token
    return "comfy-" + hashlib.sha1(stem.encode("utf-8")).hexdigest()[:10]


def unique_stem(slug, directory, allow_overwrite):
    """重名不覆盖：加 -2、-3。覆盖是用户点过勾才允许的事。"""
    if allow_overwrite or not (directory / (slug + ".json")).exists():
        return slug
    for n in range(2, 100):
        candidate = "%s-%d" % (slug, n)
        if not (directory / (candidate + ".json")).exists():
            return candidate
    return "%s-%d" % (slug, int(time.time()))


def looks_like_api_prompt(value):
    """API 格式的判断：顶层是 {节点id: {class_type, inputs}}，不是数组也不是界面格式。"""
    if not isinstance(value, dict) or not value:
        return False
    for key, node in value.items():
        if not isinstance(node, dict):
            return False
        if not isinstance(node.get("class_type"), str):
            return False
    return True


def build_bundle(title, stem, prompt_text):
    """画布功能包。只有一个 comfy_generate 节点，workflow 填刚写出去的文件名。

    参数只留 prompt 一个可填的：换场景、换服装都改这一处。
    workflow 写死在节点里，用户在画布上看得见、改得动，但不用自己记文件名。
    """
    flow_id = flow_id_for(stem)
    return {
        "schemaVersion": 1,
        "rootId": flow_id,
        "flows": [
            {
                "id": flow_id,
                "name": title,
                "compound": False,
                "nodes": [
                    {
                        "id": "n1",
                        "type": "comfy_generate",
                        "x": 160,
                        "y": 140,
                        "params": {
                            "prompt": prompt_text or "",
                            "workflow": stem + ".json",
                        },
                        "note": "ComfyUI 导出的工作流：%s" % (stem + ".json"),
                    }
                ],
                "edges": [],
            }
        ],
        "tools": [
            {
                "id": "comfy_generate",
                "name": "出图",
                "plugin": "comfy",
                "category": "生图",
                "input": "提示词",
                "output": "图片路径",
            }
        ],
    }


def resolve_targets(cfg):
    """分成「能用」和「配了但不存在」两组。

    不存在的那个不替用户创建——路径写错时静默建一棵空目录，比报错更难查。
    """
    ready, missing = [], []
    for item in cfg["targets"]:
        path = Path(item)
        if path.is_dir():
            ready.append(path)
        else:
            missing.append(item)
    return ready, missing


def register_routes():
    routes = web.RouteTableDef()

    @routes.post("/whalelife/export")
    async def export(request):
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "请求体不是 JSON。"}, status=400)

        prompt = body.get("api") or body.get("prompt")
        if not looks_like_api_prompt(prompt):
            return web.json_response(
                {
                    "ok": False,
                    "error": "这不是 ComfyUI 的 API 格式工作流（顶层应当是 {节点id: {class_type, inputs}}）。",
                },
                status=400,
            )

        title = str(body.get("name") or "ComfyUI 功能").strip()[:40] or "ComfyUI 功能"
        cfg = load_config()
        allow_overwrite = body.get("overwrite") is True and cfg["allowOverwrite"] is True

        ready, missing = resolve_targets(cfg)
        if not ready:
            hint = (
                "没有可写的目标目录。请在 %s 里把 targets 填成 WhaleLife 的 comfy 插件目录，"
                "例如 D:\\WhaleLife\\plugins\\comfy（可填多个）。" % CONFIG
            )
            if missing:
                hint += " 现在配置的这几个都不存在：%s。" % "；".join(missing)
            return web.json_response(
                {"ok": False, "error": hint, "missing": missing}, status=409
            )

        # 工作流里第一个 CLIPTextEncode 的正向文本，拿来当画布节点的初始提示词。
        hint_text = ""
        for node in prompt.values():
            if node.get("class_type") == "CLIPTextEncode":
                text = (node.get("inputs") or {}).get("text")
                if isinstance(text, str) and text.strip():
                    hint_text = text.strip()[:400]
                    break

        base_slug = slugify(body.get("slug") or title)
        written = []
        for target in ready:
            raw_dir = target / cfg["workflows"]
            flow_dir = target / cfg["canvasFlows"]
            try:
                raw_dir.mkdir(parents=True, exist_ok=True)
                flow_dir.mkdir(parents=True, exist_ok=True)
                # 每个目标各自算重名，不然一台有同名文件会连累另一台也变成 -2。
                stem = unique_stem(base_slug, raw_dir, allow_overwrite)
                raw_file = raw_dir / (stem + ".json")
                flow_file = flow_dir / (stem + ".json")
                raw_file.write_text(
                    json.dumps(prompt, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                flow_file.write_text(
                    json.dumps(build_bundle(title, stem, hint_text), ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            except Exception as error:
                return web.json_response(
                    {
                        "ok": False,
                        "error": "写 %s 失败：%s" % (target, error),
                        "written": written,
                    },
                    status=500,
                )
            written.append(
                {"target": str(target), "slug": stem, "workflow": str(raw_file), "flow": str(flow_file)}
            )

        first = written[0]
        return web.json_response(
            {
                "ok": True,
                "slug": first["slug"],
                "workflow": first["workflow"],
                "flow": first["flow"],
                "targets": written,
                "missing": missing,
                "note": "在思维画布点「注册功能」即可导入；出图仍然走 comfy_generate，workflow 填 %s。"
                % (first["slug"] + ".json"),
            }
        )

    @routes.get("/whalelife/config")
    async def config(_request):
        cfg = load_config()
        ready, missing = resolve_targets(cfg)
        return web.json_response(
            {
                "ok": True,
                **cfg,
                "ready": [str(p) for p in ready],
                "missing": missing,
            }
        )

    return routes


try:
    from server import PromptServer

    PromptServer.instance.app.add_routes(register_routes())
    print("[WhaleLife] 导出路由已挂上：POST /whalelife/export")
except Exception as error:  # ComfyUI 换了接口也不该让启动失败
    print("[WhaleLife] 路由挂载失败：%s" % error)

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
