#!/bin/bash
# macOS：双击本文件即可启动 DeepSeek直搜，并自动打开浏览器。
# 首次如果提示“无法打开，因为来自身份不明的开发者”，右键 → 打开 即可。
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js。"
  echo "请先安装 LTS 版本：https://nodejs.org/zh-cn"
  read -r -p "按回车键打开下载页…" _
  open "https://nodejs.org/zh-cn"
  exit 1
fi

echo "正在启动 DeepSeek直搜…（关闭此窗口即停止服务）"
node server.mjs --open
