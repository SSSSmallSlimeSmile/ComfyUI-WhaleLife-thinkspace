# ComfyUI-WhaleLife-thinkspace

在 ComfyUI 里点一下，把当前工作流导出成 [WhaleLife](https://github.com/iinukami/whalelife) 思维画布能直接导入的「功能」。

适用于 [WhaleLife](https://github.com/iinukami/whalelife) 的 `thinking-space` 插件 + `comfy` 生图插件。

## 它做什么

菜单 **编辑**（英文界面 **Edit**）下面有两条命令：

| 命令 | 做什么 | 要不要装 WhaleLife |
| --- | --- | --- |
| **存到 WhaleLife** | 直接写进本机那份 `comfy` 插件目录 | 要 |
| **导出画布功能文件（下载）** | 下载成一个 `.json`，自己拿去导入 | 不要 |

「存到 WhaleLife」会写两份文件：

| 写哪里 | 是什么 | 谁用 |
| --- | --- | --- |
| `plugins/comfy/workflows/<名字>.json` | ComfyUI 的 API 格式工作流 | `comfy_generate` 的 `workflow` 参数 |
| `plugins/comfy/canvas-flows/<名字>.json` | 思维画布的「功能包」（`schemaVersion: 1`） | 画布工具栏的 **注册功能** |

两份同名不同目录，改了哪个一眼认得出。

「导出画布功能文件（下载）」只产出**功能包**，不写盘、不要求 `config.json` 配好。适合：给另一台机器、或者本机暂时没装 WhaleLife。走浏览器下载，文件落在浏览器的下载目录里——**看得见、能带走、能传给别的画布**。

注意两条下载路线的区别：**功能包**只是画布上的一个节点（`workflow` 指向某个文件名），它**不含**工作流本身。要把图真的画出来，工作流 JSON 也得一起带过去——那份用「存到 WhaleLife」，或者手动放进 `plugins/comfy/workflows/`。

## 装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/SSSSmallSlimeSmile/ComfyUI-WhaleLife-thinkspace
```

重启 ComfyUI。启动日志里应当出现：

```
[WhaleLife] 导出路由已挂上：POST /whalelife/export
```

然后 **硬刷新浏览器**（Ctrl+Shift+R）——脚本是静态加载的，不刷新看不到菜单项。

## 配

复制 `config.example.json` 成 `config.json`，填 WhaleLife 的 comfy 插件目录：

```json
{
  "targets": ["D:\\WhaleLife\\plugins\\comfy"],
  "workflows": "workflows",
  "canvasFlows": "canvas-flows",
  "allowOverwrite": false
}
```

| 字段 | 说明 |
| --- | --- |
| `targets` | 可以填多个。装了多份 WhaleLife（比如日常版和测试版各一份）时，一次导出会写进每一条存在的目录 |
| `workflows` | 工作流子目录名，相对 `targets` 里那一层 |
| `canvasFlows` | 功能包子目录名，`comfy-bridge` 从这儿读 |
| `allowOverwrite` | 默认 `false`，重名自动加 `-2`、`-3`。只有这里为 `true`，请求里再带 `overwrite: true` 才覆盖 |

`targets` 里写错的路径**不会被自动创建**——路径写错时静默建一棵空目录，比报错更难查。导出时会明确告诉你哪几个不存在。

## 用

1. ComfyUI 里把图连好，先自己跑通一次
2. **编辑 → 存到 WhaleLife**，起个名字
3. 到 WhaleLife 的思维画布，工具栏 **注册功能**，选刚生成的那条
4. 画布上会多两个节点：`文本输入` → `出图`。`workflow` 已经填好，提示词在输入节点里
5. 发布成技能组，在聊天或 QQ 里跑

> 画布上点「试跑」是模拟执行，不出真图。要真画，必须发布成技能组之后跑。

**为什么是两个节点，不是一个**：画布把流程发布成技能时，工具节点参数里的字面量会变成固定值，
只有「从输入节点连进参数位」的东西才会变成可填参数。单节点版本的提示词是写死的，
发布出去是零参数的技能，每次都画同一张。摆一个 `input_text` 之后，发布结果是一个必填的
`prompt` 参数——换场景、换服装都只改这一处。

## 接口

想用脚本调，或者接到别的工具里：

```http
POST /whalelife/export
Content-Type: application/json

{"name": "勘-图书馆", "api": {"3": {"class_type": "KSampler", "inputs": {...}}}}
```

| 状态 | 含义 |
| --- | --- |
| `200` | `{ok: true, slug, workflow, flow, targets[], missing[]}` |
| `400` | 请求体不是 JSON，或者 `api` 不是 API 格式 |
| `409` | 没有可写的目标目录（`config.json` 的 `targets` 没填或都不存在） |
| `500` | 建目录或写文件失败 |

只要功能包、不想写盘（不需要 `targets`）：

```http
POST /whalelife/flow-bundle
Content-Type: application/json

{"name": "勘-图书馆", "api": {"3": {"class_type": "KSampler", "inputs": {...}}}}
```

回 `200 {ok: true, slug, name, filename, bundle}`，`bundle` 就是画布的功能包本体。`400` 的判定跟上面一样。

`GET /whalelife/config` 回当前配置，附带 `ready` / `missing`，用来排查路径。

## 几个踩过的坑

**为什么让 Python 写文件，而不是浏览器直接发给画布**

画布的代理只认自己那个 origin。从 `8188` 的页面 `fetch` 到画布端口，`Origin` 对不上，直接拒。放宽那条检查等于把画布的防护拆了。所以浏览器只发给本机 ComfyUI 的后端，落盘在这儿做，画布再去读文件。

**为什么挂菜单命令，而不是自己塞个按钮**

`setup()` 执行时页面还没挂完，`document.querySelector(".comfy-menu")` 是空的，塞进 `body` 的按钮会被全屏画布盖住——文件在、按钮看不见，这是最费时间的一种「没效果」。

**前端脚本的导入路径**

脚本放在 `web/` 根下，对外路径是 `/extensions/ComfyUI-WhaleLife-thinkspace/whalelife_export.js`，所以 `../../scripts/app.js` 正好落到 `/scripts/app.js`。要是再套一层 `web/js/`，就得写 `../../../`——路径错一层，整个模块导入失败，`registerExtension` 一行都不执行，浏览器控制台只报一个 404，界面上什么反应都没有。

**文件名保留中文**

`comfy_generate` 只按名字找文件，工作流下拉里也是这个名字。洗成 ascii 之后用户认不出哪个是哪个。画布那边的 id 另算（全中文名取哈希前缀），所以同一个名字重导永远是覆盖同一个 id，不会多一份。

## 许可

MIT。WhaleLife 本体是 AGPL-3.0。
