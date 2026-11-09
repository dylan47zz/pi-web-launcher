# Pi Web Launcher

macOS 的最小原生 pi-web 后台启动器：launchd + shell + 已安装 Node 的标准库 + AppleScript App，无第三方依赖、常驻终端或常驻菜单栏进程。

默认仅绑定 **`127.0.0.1:30141`**。安装、服务运行、登录自启是三个独立动作。安装不启动服务、不打开网页、不默认启用自启。

## 构建与测试（不会安装到真实 HOME）

要求 macOS、可用的 `osacompile` / `codesign` / `plutil`、Node；运行 pi-web 要求 Node ≥ 22.19.0。需事先安装 [pi-web](https://github.com/agegr/pi-web)；已验证 `@agegr/pi-web` **0.15.0**，本工具不安装、更新或修改该包或 Pi。

```sh
git clone https://github.com/dylan47zz/pi-web-launcher.git
cd pi-web-launcher
./scripts/build.sh       # 只生成项目内 dist.noindex/Pi Web.app
./scripts/test.sh        # 重建 + shell/JS 语法 + 隔离自动化测试
```

已构建时可单独运行测试：

```sh
node --test --test-timeout=60000 tests/*.test.mjs
```

只构建一个 App，固定 `CFBundleIdentifier=local.pi-web-launcher`。产物放在 `dist.noindex/`，避免 Spotlight/Raycast 同时搜到构建副本和安装副本；构建会清理可确认由本项目拥有的旧 `dist/`，遇到异主目录或链接则拒绝操作。

App 所有权标记放在 Resources 内，修改 Info.plist 后用系统 codesign 做本地 ad-hoc 封装并执行 `--verify --deep --strict`；不需要证书、开发者帐号或 keychain。

测试使用临时 HOME、假 pi-web / launchctl / ps / lsof / browser 和六个并发控制进程；不注册真实 job、不绑定真实服务端口、不调用真实浏览器、不访问真实 Pi 数据。真实 `osacompile` / `plutil` 只处理项目或临时目录的产物；用例完成后删除临时文件。

## 显式安装

安装会写入当前用户的应用和配置目录，但不启动服务、不打开浏览器、不默认启用自启。不要用 sudo。在图形登录的当前用户下显式执行：

```sh
./scripts/install.sh
# Apple Silicon Homebrew 的常见入口，也可显式指定：
./scripts/install.sh --node /opt/homebrew/bin/node --pi-web /opt/homebrew/bin/pi-web
```

安装从 PATH 探测 Node 与 pi-web，保存 Node 的稳定绝对入口（如 `/opt/homebrew/bin/node`，不固定 Cellar 版本目录），解析 pi-web 的真实 JS 入口，并调用上游 `version` 进行 Node 版本校验。可使用 `--agent-dir /absolute/path` 指定另一 Pi 数据目录；默认 `~/.pi/agent`，**不会自动继承当前项目的 PI_CODING_AGENT_DIR**，也不扫描数据或凭据。

安装位置：

| 路径 | 用途 |
| --- | --- |
| `~/Applications/Pi Web.app` | 原生控制面板：显示状态，提供“打开网页”和“登录自启设置”，不出现 Terminal 窗口 |
| `~/Library/Application Support/pi-web-launcher/pi-webctl` | shell 控制入口 |
| 同目录 `config.json` / `local.pi-web.plist` / `.mjs` | 私有配置、稳定服务定义、标准库控制逻辑 |
| `~/Library/LaunchAgents/local.pi-web.plist` | **仅自启 on 时**存在，权限 0600 的服务 plist 拷贝 |
| `~/Library/Logs/pi-web/{stdout,stderr}.log` | 服务日志，卸载保留 |

配置目录/脚本权限 0700，配置/plist 0600；拒绝同名异主文件、非应用所有的 App、符号链接和 group/world 可写的管理路径。安装后启动不依赖源码仓库；保留仓库便于以后升级或卸载。

重复安装刷新本应用文件，保留自启选择，不启停服务；升级会移除可确认拥有的旧 `~/Applications/Pi Web Autostart.app`，不再构建或安装伴随 App。旧 App 若是异主文件或链接，安装/卸载在任何删除或停机前就会拒绝操作。已有 job 加载时禁止改变依赖路径/代理/agent 目录，先显式 stop；同名但不能验证为本应用的 job 会拒绝操作。不会安装全局命令或修改 shell 配置。

## 使用

```sh
CTL="$HOME/Library/Application Support/pi-web-launcher/pi-webctl"
"$CTL" start             # 只后台启动；重复调用复用
"$CTL" open              # 确保就绪后打开 http://127.0.0.1:30141
"$CTL" status            # 服务 + 自启状态；未就绪/冲突/身份异常返回非零
"$CTL" autostart on      # 下次登录后台启动，不打开网页；不启动当前服务
"$CTL" autostart off     # 只关闭下次登录自启，不打断当前服务
"$CTL" stop              # bootout 本应用 job；保留下次登录自启选择
```

也可以从 Finder/Raycast 打开唯一的 `Pi Web.app`：先显示服务/自启状态，默认按钮“打开网页”（回车即可）会确保服务就绪后打开网页；“登录自启设置”进入开启/关闭对话框，取消不会更改设置。为将两种操作合入一个最小原生 App，双击现在先显示控制面板，而不是立即打开网页；命令行 `open` 仍可直接打开。

自启设置不需要编辑 XML，不会打开网页或启停当前服务。“自启 on”在这里表示本应用登录入口存在，不表示系统已允许后台项，也不代表当前服务在运行。

### 启动、身份与停止边界

- 只操作当前用户 `gui/<uid>/local.pi-web`；没有 LaunchDaemon、sudo、`disable`、`kickstart -k` 或 KeepAlive。
- start bootstrap 稳定 plist；已加载但停着时 kickstart；已运行则复用。安装/控制/卸载通过原子目录锁串行，重复和并发不会额外 bootstrap。
- 就绪最多轮询 30 秒（单次 CLI/系统命令另有有限超时）；核对 launchd 的路径/参数/PID，以及 pi-web `status` 的具体记录、launcher 的 UID/入口、Next 子进程关系和监听 PID。仅 TCP 通、任意 HTTP 回应或 `status` 退出码 0 都不算就绪。HTTP 可访问性使用上游 status 自带探测，包含受密码保护的 401 回应。
- 同地址手动启动的 pi-web，经身份检查后可被 start/open 复用，status 明确标记 **manual/unmanaged**。**ctl stop 和卸载不会停止手动服务**：控制锁无法约束手动进程更换，避免按端口二次选择的竞态。要停手动服务，由用户确认后显式执行 `pi-web stop --port 30141`。
- 非 pi-web 占端口、非 loopback 记录、多个相同端口记录、孤儿 Next 服务或身份不匹配一律报错，不杀进程、不换端口。就绪超时不自动 bootout，避免破坏迟到启动/活动任务；查看日志后显式 stop。
- launchd 设置 ExitTimeOut=30，但**上游 pi-web 0.15.0 自己会在收到停止信号约 5 秒后强制结束 Next 子进程**。本项目不另发 SIGKILL；主动 stop、卸载或注销仍可能中断活动 agent 任务，请先等任务完成。

### 环境 / 代理

launchd 不读取 `.zshrc`。服务固定 HOME、用户 HOME 工作目录及 Pi agent 目录；PATH 包含 Pi bin、`~/.local/bin`、Homebrew、系统工具及首次安装 PATH 的绝对目录项。不会把当前会话的其它环境变量/凭据复制到配置或 plist。

只提供无凭据 HTTP(S) 代理源地址的显式入口：

```sh
"$CTL" stop
./scripts/install.sh --proxy http://127.0.0.1:7890
"$CTL" start
# 清除代理，同样先 stop：
"$CTL" stop
./scripts/install.sh --proxy off
```

该选项写入 HTTP_PROXY / HTTPS_PROXY，并固定 NO_PROXY=`localhost,127.0.0.1,::1`。拒绝带用户名、密码、路径或 query 的代理 URL；不自动导入代理、API key 或 PI_WEB_PASSWORD。依赖已有 Pi 配置/凭据；其它特殊环境需求不在第一版入口范围内。

## 诊断与升级

```sh
"$CTL" status
/bin/launchctl print "gui/$(id -u)/local.pi-web"  # 只读诊断
/usr/bin/plutil -lint "$HOME/Library/Application Support/pi-web-launcher/local.pi-web.plist"
tail -n 80 "$HOME/Library/Logs/pi-web/stderr.log"
tail -n 80 "$HOME/Library/Logs/pi-web/stdout.log"
```

若提示控制锁超时，可能另一个控制操作正在进行，或控制器被强行终止后遗留了锁。先确认没有运行中的 installer/pi-webctl，并检查以下文件中的 PID；**只有确认无活动控制器后**才删除锁目录，不要盲目解除并发保护：

```sh
LOCK="$HOME/Library/Application Support/.pi-web-launcher.lock"
cat "$LOCK/pid"
# 确认 PID 及其它控制器均不在运行之后：
rm -r "$LOCK"
```

本项目不自动更新全局 npm 包。升级流程（由用户自行授权 npm 更新）：

```sh
"$CTL" stop             # 若存在手动服务，需单独处理；确认所有相关任务已结束
# 此处由用户自行更新已安装的 pi-web / Node
./scripts/build.sh
./scripts/install.sh    # 重新探测并验证，保留自启选择
"$CTL" start
```

上游尚无结构化 status CLI。本项目有一个小的兼容边界：解析 0.15.0 的 status 文本，并只读目标 run-record 的 `pid/nextPid/hostname/port/url` 来排除将 wildcard 映射成 loopback 的记录；不导入其内部模块、不写运行记录、不改 Pi 配置。上游改变格式时保守失败，不猜测或误停服务。缺失 Node/pi-web 需先修复依赖；卸载只需 PATH 上有可用 Node，不要求已安装服务的旧依赖仍存在。

## 显式卸载

先结束活动任务。未确认时脚本仅说明影响并退出：

```sh
./scripts/uninstall.sh         # 只显示确认要求
./scripts/uninstall.sh --yes   # 显式确认：停止本应用 job，移除自身文件/App/自启入口
```

卸载核对所有权、plist 内容、job 参数及进程入口；验证失败则保留安装，绝不停止同名异主 job。仅删除可确认拥有的 App/控制文件/自启拷贝；保留日志、额外未知文件、手动服务、`~/.pi/agent`、npm pi-web 和源码仓库。正常重复卸载无副作用；残留未知文件只报告、不删除。不要用删除 `.pi` 或 npm 包替代卸载。

## 验证结果与已知限制

2026-11-09，macOS Apple Silicon、pi-web 0.15.0 下：

- `./scripts/test.sh` **15/15 通过**：原生 App 编译、plist 校验、shell/JS 语法及隔离自动化测试。
- 自动化覆盖重复/并发启动、已加载但未运行的 job、手动服务复用、冲突/超时/失败退出、进程身份、自启独立性、缺失依赖、非法参数、空格/引号路径、异主文件、安全安装/卸载与数据保留。
- 包含单 App/固定标识、编译后前台激活/reopen handler、原生 AppleScript 调用假 ctl 的分发测试、旧伴随 App 安全迁移、构建目录防误删和安装后签名 strict 校验。handler 测试不显示真实对话框，不能代替 GUI 验收。
- 真实安装/重复安装、launchd 启停、3 个并发 start、App 冷启动/复用、loopback HTTP、端口释放和 Spotlight 唯一安装副本已验证；App 前台面板可见性已由用户确认。
- **真实登录自启、系统后台项许可、模型/代理请求、活动任务停止及真实卸载仍未验证。** 自动化使用假 launchctl，不能据此宣称登录行为已实测。Raycast 自身缓存/过滤行为未独立验证。

建议人工验收：开启自启后确认当前服务不中断，手动注销/登录检查仅后台启动、不弹浏览器；关闭自启后再次登录检查不启动。登录/停机可能中断活动任务，请先结束任务，避免用重要任务测试。

只提供源码构建和本地 ad-hoc 封装，不提供开发者证书签名/公证、图标/DMG、常驻菜单栏、远程访问、日志轮转、崩溃重启或自动更新。
