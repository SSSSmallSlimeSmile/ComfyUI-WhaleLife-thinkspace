# -*- coding: utf-8 -*-
"""把 ComfyUI 的当前工作流导出成「思维画布」能直接导入的功能。

四件事想清楚才这么写：

1. 不碰 ComfyUI 界面代码。走它自己的扩展机制：两条 HTTP 路由 + 一个小脚本。
   升级 ComfyUI 不会把这里冲掉。

2. 浏览器不直接找画布。画布代理只认自己那个 origin，从 8188 发过去的请求会被
   拦掉——放宽它等于拆防护。所以这里由 Python 落盘，画布那边再读文件。
   两边谁也不认识谁，各写各的。

3. 两种出口，用途不同：
   - 写盘：<target>/workflows/<slug>.json       ComfyUI 的 API 格式，comfy_generate 靠它跑
           <target>/canvas-flows/<slug>.json     画布的功能包（schemaVersion 1）
     要求本机有一份 WhaleLife（comfy 插件目录）。
   - 下载：/whalelife/flow-bundle 只回功能包，不写盘。
     给「只想把文件带走」的人用——没有安装 WhaleLife 也能导出，拿到别的机器再导入。
   功能包只由 build_bundle 生成一份，两条路都走它，不各自实现一遍。

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
    """画布功能包。文本输入 → comfy_generate 两个节点，workflow 填刚写出去的文件名。

    为什么不是单节点：画布发布成技能时，「工具节点里的字面量」会被写死成固定值，
    只有从输入节点连进参数位的东西才会变成可填参数。单节点版本发布出去是零参数，
    每次都画同一张。所以这里摆一个 input_text，prompt 走连线进去。

    用户在画布上：改提示词就跟改一个输入框一样；workflow 写死在节点里，
    看得见、改得动，但不用自己记文件名。
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
                        "type": "input_text",
                        "x": 80,
                        "y": 150,
                        "value": prompt_text or "",
                        "note": "提示词：换场景、换服装只改这一格",
                    },
                    {
                        "id": "n2",
                        "type": "comfy_generate",
                        "x": 420,
                        "y": 150,
                        "params": {
                            "prompt": "${n1}",
                            "workflow": stem + ".json",
                        },
                        "note": "ComfyUI 导出的工作流：%s" % (stem + ".json"),
                    },
                ],
                "edges": [["n1", "n2", "prompt"]],
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


def hint_text_from(prompt):
    """工作流里第一个 CLIPTextEncode 的正向文本，拿来当画布节点的初始提示词。"""
    for node in prompt.values():
        if node.get("class_type") == "CLIPTextEncode":
            text = (node.get("inputs") or {}).get("text")
            if isinstance(text, str) and text.strip():
                return text.strip()[:400]
    return ""


def parse_body(body):
    """两条路由共用的解析：校验工作流、定名字、取提示词初值。

    返回 dict；不合格就抛 ValueError，调用方把它换成 400。
    """
    prompt = body.get("api") or body.get("prompt")
    if not looks_like_api_prompt(prompt):
        raise ValueError(
            "这不是 ComfyUI 的 API 格式工作流（顶层应当是 {节点id: {class_type, inputs}}）。"
        )
    title = str(body.get("name") or "ComfyUI 功能").strip()[:40] or "ComfyUI 功能"
    return {
        "prompt": prompt,
        "title": title,
        "slug": slugify(body.get("slug") or title),
        "hint": hint_text_from(prompt),
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

        try:
            parsed = parse_body(body)
        except ValueError as error:
            return web.json_response({"ok": False, "error": str(error)}, status=400)

        prompt = parsed["prompt"]
        title = parsed["title"]
        cfg = load_config()
        allow_overwrite = body.get("overwrite") is True and cfg["allowOverwrite"] is True

        ready, missing = resolve_targets(cfg)
        if not ready:
            hint = (
                "没有可写的目标目录。请在 %s 里把 targets 填成 WhaleLife 的 comfy 插件目录，"
                "例如 D:\\WhaleLife\\plugins\\comfy（可填多个）。"
                "只想拿文件的话，用菜单里的「导出画布功能文件（下载）」，那个不需要装 WhaleLife。" % CONFIG
            )
            if missing:
                hint += " 现在配置的这几个都不存在：%s。" % "；".join(missing)
            return web.json_response(
                {"ok": False, "error": hint, "missing": missing}, status=409
            )

        base_slug = parsed["slug"]
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
                    json.dumps(build_bundle(title, stem, parsed["hint"]), ensure_ascii=False, indent=2),
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

    @routes.post("/whalelife/flow-bundle")
    async def flow_bundle(request):
        """只回功能包，不碰磁盘。

        给「没有 WhaleLife 的机器」用：在 ComfyUI 里连好图，导出这个文件，
        带走到另一台的画布上导入。所以这里不要求 targets 配好。
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "请求体不是 JSON。"}, status=400)

        try:
            parsed = parse_body(body)
        except ValueError as error:
            return web.json_response({"ok": False, "error": str(error)}, status=400)

        stem = parsed["slug"]
        return web.json_response(
            {
                "ok": True,
                "slug": stem,
                "name": parsed["title"],
                "filename": stem + ".json",
                "bundle": build_bundle(parsed["title"], stem, parsed["hint"]),
                "note": "这是画布的功能包，不是 ComfyUI 的 API 工作流。"
                "拿到思维画布点「注册功能」粘贴，或用「导入工作流」选这个文件。",
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
    print("[WhaleLife] 导出路由已挂上：POST /whalelife/export, POST /whalelife/flow-bundle")
except Exception as error:  # ComfyUI 换了接口也不该让启动失败
    print("[WhaleLife] 路由挂载失败：%s" % error)

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
