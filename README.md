# DeepSeek直搜

> 用你自己的 DeepSeek API Key，在本机跑一个干净的搜索页：**联网回答 + 10 条可点链接 + 还有多少条没显示**，搜索历史与归档都留在本地。

- 无第三方依赖，只用 Node 内置模块
- 双击启动（macOS / Windows），浏览器自动打开
- 请求直达 `api.deepseek.com`，不经过任何中转
- 标题、API 地址、模型、Key、广度都能在页面里改，改完立即生效
- 页面里就能看到**当前 Key 的后 4 位**和**账户余额**

![搜索页](docs/preview.png)

<sub>截图用的是虚构演示数据（example.com 链接），仓库里不含任何真实 API Key 或搜索记录。</sub>


---

## 一、快速开始

### 方式 A：双击启动（推荐给非开发者）

| 系统 | 操作 |
|------|------|
| macOS | 双击 `start.command`（首次若提示"无法打开"→ 右键 → 打开） |
| Windows | 双击 `start.bat` |

脚本会自动检测 Node.js，缺了会带你去官网下载；启动后自动打开 `http://127.0.0.1:8787`。
关闭终端窗口 = 停止服务。

### 方式 B：命令行

```bash
node server.mjs --open     # 启动并打开浏览器
node server.mjs            # 只启动，手动访问 http://127.0.0.1:8787
```

### 方式 C：npm 全局安装

```bash
npm install -g .
dsearch --open
```

### 前置条件

Node.js **18 或更高**（`node -v` 查看）。没有的话去 <https://nodejs.org/zh-cn> 装 LTS 版即可，一路下一步。

---

## 二、第一次进入

首次打开（本机还没有 Key 时）会自动弹出设置窗：

![开始使用](docs/settings.png)


1. **页面标题** —— 左上角显示什么随你改，例如"我的直搜"。
2. **API 地址** —— 默认 `https://api.deepseek.com/anthropic/v1`；换成兼容 Anthropic Messages 协议的网关也可以。
3. **模型** —— 默认 `deepseek-v4-flash`。
4. **API Key** —— 填你自己的 `sk-...`。只写进本机 `data/settings.json`，不会上传。
5. **默认检索广度** —— 1 / 2 / 3 / 5。

保存后：
- 左上角标题立即变成你设的内容；
- 设置区显示 **当前 Key：sk-…后四位** 和 **余额 ¥xx.xx（充值 / 赠送）**，旁边有「刷新」；
- 可以开始搜索。

之后想再改：鼠标移到标题上会出现「编辑」小按钮（和 QQ 空间的编辑一样），点它即可；点标题本身也行。

![编辑按钮](docs/edit-button.png)

---

## 三、界面说明

**顶部**：图标 + 标题（悬停出现「编辑」）+「外观」；下面是搜索框和搜索按钮。

**搜索后才出现**的参数条：广度（下拉可改，改完自动重搜并记住）· 检索次数 · 来源条数 · 显示条数 · 用时 · token 消耗。

**回答**：markdown 渲染，标题/列表/表格/代码块/链接都可用，右上角可复制。

**相关链接**：默认 10 条，标题和 URL 都能点；底部标注「还有 N 条未显示」，可展开/收起。

**左侧**：
- 搜索历史：最近 10 条，显示前 8 个字（超出用 `…`），蓝色可点，点开即看那次结果；
- 每条后面紧跟 **归档**、**删除** 两个小图标；
- 归档：历史下方，最多 10 条，可点开、可删除，文件存本地；
- **更多 ↗**：直接在访达/资源管理器打开归档文件夹，里面是每次搜索保存的完整 HTML，双击即可离线查看。

**外观**：背景色（调色盘或直接输入 `#F5F5DC`）、字号（12–24）、字体（苹方/宋体/楷体/黑体/冬青黑体/华文宋体/思源宋体/Georgia/Menlo，或自定义字体名）。设置存在浏览器 localStorage。

---

## 四、数据放在哪

```
data/
├── settings.json          # 标题、API 地址、模型、Key、广度（含密钥，注意备份/保密）
├── history.json           # 历史索引（最多 60 条）
├── archive.json           # 归档索引
├── results/<id>.json      # 每次搜索的完整结果
├── results/<id>.html      # 该次结果的静态快照
└── archive/<id>.{json,html}
```

整个 `data/` 就是你的全部数据，**备份它等于备份历史**；换机器时把 `data/` 拷过去即可。

---

## 五、配置项（环境变量）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 只监听本机，别改成 `0.0.0.0` |
| `DSZS_DATA_DIR` | `./data` | 数据目录，放 U 盘/同步盘时用 |
| `DEEPSEEK_SEARCH_MODEL` | `deepseek-v4-flash` | 模型（页面设置优先） |
| `DEEPSEEK_SEARCH_BASE_URL` | `https://api.deepseek.com/anthropic/v1` | 接口地址（页面设置优先） |
| `MAX_SHOWN` | `10` | 首页展示几条 |
| `SEARCH_TIMEOUT_MS` | `180000` | 单次检索超时 |
| `SEARCH_CONCURRENCY` | `1` | 同时发起几次检索 |
| `SEARCH_STAGGER_MS` | `250` | 相邻检索间隔 |

**凭据优先级**：页面设置里的 Key → `DEEPSEEK_API_KEY` 环境变量 → `~/.dsh/.credentials.yaml`。

---

## 六、检索广度与花费

「广度 N」= 串行发起 N 次检索（先让模型把问题拆成 N-1 个不同角度的检索式），结果去重合并：

| 广度 | 模型调用 | 典型来源 | 大致耗时 |
|------|----------|----------|----------|
| 1 | 1 次 | ~10 条 | 3–5 秒 |
| 3（默认） | 4 次 | 20–30 条 | 15–25 秒 |
| 5 | 6 次 | 30–50 条 | 25–40 秒 |

全部计入你自己的 API 额度（一次约 4k–7k 输入 token）。参数条会显示实际消耗。

检索默认串行：并行握手更容易被对端重置，串行 + 间隔更稳；着急可设 `SEARCH_CONCURRENCY=2`。

---

## 七、发布到 GitHub

```bash
cd uploadgit      # 或你解压后的目录名
git init
git add .
git commit -m "feat: DeepSeek直搜 v1.0.0"
git branch -M main
gh repo create deepseek-direct-search --public --source=. --push
# 没有 gh 的话：在 GitHub 建空仓库，然后
# git remote add origin git@github.com:<你>/deepseek-direct-search.git
# git push -u origin main
```

`data/` 已在 `.gitignore` 里——**别把带 key 的 settings.json 提交上去**。

发布 Release 时，把整个目录打成 zip 传上去，别人下载解压双击 `start.command` / `start.bat` 就能用。

---

## 八、想做成真正的安装包？

这个项目本身是"零依赖 + 双击启动"，不需要安装器。如果一定要 `.dmg` / `.exe`：

- **最简单**：Release 里放 zip，用户解压双击脚本（要求本机有 Node）。
- **带运行时的单文件**：用 [pkg](https://github.com/vercel/pkg) 或 Node SEA 把 `server.mjs` 打包成二进制，再用 [Inno Setup](https://jrsoftware.org/isinfo.php)（Windows）/ [create-dmg](https://github.com/create-dmg/create-dmg)（macOS）套一层安装器。
- **桌面 App**：套 [Electron](https://www.electronjs.org/) 或 [Tauri](https://tauri.app/)，把 `public/index.html` 当窗口内容，主进程里 `import './server.mjs'`。

仓库没有内置这些打包流程，避免把简单工具搞复杂；需要的话可以按上面任选其一。

---

## 九、常见问题

**端口被占用？** `PORT=8080 node server.mjs`。

**Windows 双击闪退？** 多半是没装 Node：命令行执行 `node -v` 确认。

**余额显示"账号登录态不支持"？** 说明用的是 DeepSeek 账号登录态而不是 API Key，去页面里填一个 `sk-` 开头的 Key 即可。

**换了 key 要重启吗？** 不用，保存后下一次搜索就用新 key。

**安全吗？** 只监听 `127.0.0.1`，写接口校验 `Origin`（别的网页无法借你的 key 花钱），密钥不写日志。但 `data/settings.json` 是明文，注意别把它发给别人。

---

## License

MIT
