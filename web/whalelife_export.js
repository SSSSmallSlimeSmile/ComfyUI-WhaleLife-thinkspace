// 把当前 ComfyUI 工作流导出成「思维画布」能直接导入的功能。
//
// 为什么不让浏览器直接找画布：画布那边的代理只认自己那个 origin，
// 从 8188 发过去的请求会被它拦掉（304 都没有，直接拒）。放宽它等于拆防护。
// 所以这里只把图交给本机 ComfyUI 的后端，落盘那一步在 __init__.py 里。
// 两边谁也不认识谁，各写各的，坏一边不至于把另一边拖死。
//
// 为什么挂菜单命令而不是自己往 DOM 里塞按钮：setup() 跑的时候页面还没挂完，
// 塞进 body 的按钮会被画布盖住——文件在、按钮看不见，最费时间的一种"没效果"。
// 菜单是前端自己的东西，它什么时候画好由它决定。
//
// 为什么有两个命令：
//   存到 WhaleLife        写到本机那份 comfy 插件目录里，画布的「注册功能」直接列出
//   导出画布功能文件      下载成一个文件，不依赖本机有没有装 WhaleLife
// 后者的理由是：文件看得见、能带走。落盘那条路对用户是隐形的，出问题时
// 连"东西到底长什么样"都无从判断。功能包本身只有后端 build_bundle 生成一份，
// 这里只负责下载，不在 JS 里再拼一次。
import { app } from "../../scripts/app.js";

const EXPORT_ID = "whalelife.export";
const DOWNLOAD_ID = "whalelife.downloadFlow";

function toast(message, bad) {
  try {
    if (app.extensionManager?.toast) {
      app.extensionManager.toast.add({
        severity: bad ? "error" : "success",
        summary: "WhaleLife",
        detail: message,
        life: bad ? 12000 : 6000,
      });
      return;
    }
  } catch {
    /* 老前端没有 toast，退回 alert */
  }
  window.alert("WhaleLife：" + message);
}

// API 格式：顶层是 {节点id: {class_type, inputs}}，不是界面格式那种数组。
function looksLikeApiPrompt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length) return false;
  for (const key of keys) {
    const node = value[key];
    if (!node || typeof node !== "object") return false;
    if (typeof node.class_type !== "string") return false;
  }
  return true;
}

async function collectApi() {
  let api = null;
  try {
    // 前端自带的取法：graphToPrompt() 回来的是 {workflow, output}，
    // output 才是 API 格式。别自己遍历图，漏了子图就少节点。
    const result = await app.graphToPrompt();
    api = result?.output ?? result;
  } catch (error) {
    toast("取当前工作流失败：" + (error?.message || error), true);
    return null;
  }

  if (!looksLikeApiPrompt(api)) {
    toast("当前画布取不到 API 格式的工作流，先在 ComfyUI 里把图连好、能跑通再说。", true);
    return null;
  }
  return api;
}

function askName(title) {
  const name = window.prompt(title, "ComfyUI 功能");
  if (name === null) return null;
  const trimmed = String(name).trim().slice(0, 40);
  if (!trimmed) {
    toast("名字不能是空的。", true);
    return null;
  }
  return trimmed;
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  // 有的前端把 body 的点击吞掉，挂到 a 自己身上再点最稳。
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportCurrent() {
  const api = await collectApi();
  if (!api) return;

  const name = askName("给这份功能起个名字（会同时生成 ComfyUI 工作流和画布功能包）");
  if (name === null) return;

  try {
    const response = await fetch("/whalelife/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, api }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      // 后端把"该改哪个配置"写进 error 里了，原样转给用户，别自己编一句。
      toast(data.error || `导出失败（HTTP ${response.status}）`, true);
      return;
    }

    const count = Array.isArray(data.targets) ? data.targets.length : 1;
    toast(
      `已导出「${data.slug}」，写入 ${count} 个 WhaleLife：` +
        `${data.slug}.json（工作流）+ ${data.slug}.json（画布功能包）。` +
        `到思维画布点「注册功能」就能导入。`,
      false,
    );
  } catch (error) {
    toast("连不上 ComfyUI 后端：" + (error?.message || error), true);
  }
}

async function downloadFlowBundle() {
  const api = await collectApi();
  if (!api) return;

  const name = askName("给这份功能起个名字（会下载成画布能导入的文件）");
  if (name === null) return;

  try {
    const response = await fetch("/whalelife/flow-bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, api }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.ok) {
      toast(data.error || `导出失败（HTTP ${response.status}）`, true);
      return;
    }

    downloadJson(data.filename, data.bundle);
    toast(
      `已下载「${data.filename}」。拿到思维画布点「注册功能」粘贴，或用「导入工作流」选这个文件。` +
        `注意：它只是画布的功能包，不含 ComfyUI 的工作流本身——那份要用「存到 WhaleLife」或者手动放进 workflows 目录。`,
      false,
    );
  } catch (error) {
    toast("连不上 ComfyUI 后端：" + (error?.message || error), true);
  }
}

app.registerExtension({
  name: "WhaleLife.ThinkSpace.Export",
  commands: [
    { id: EXPORT_ID, label: "存到 WhaleLife", function: exportCurrent },
    { id: DOWNLOAD_ID, label: "导出画布功能文件（下载）", function: downloadFlowBundle },
  ],
  // 挂在「编辑」下面：跟 打开/保存/导出 是同一类动作，不该自成一级菜单。
  menuCommands: [{ path: ["Edit"], commands: [EXPORT_ID, DOWNLOAD_ID] }],
});
