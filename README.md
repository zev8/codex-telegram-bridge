# Codex Telegram Bridge

把 Telegram 和本机 Codex 连接起来的桥接服务。你可以在 Telegram 里直接向本机 Codex 发消息、上传图片、处理审批，并在多个 Codex 会话之间切换；底层仍然使用原生 `codex app-server`，而不是重写一个简化版聊天机器人。

这个项目的设计目标是把 Telegram 变成 Codex 的远程入口，同时把个人 bot 配置、运行数据和日志都移出仓库，方便继续开发并安全同步到 GitHub。

## 功能

- 原生桥接本机 `codex app-server`，保留 Codex 的 thread、turn、approval、skills 等语义
- 支持私聊、群组、超级群，可让不同聊天绑定不同 Codex 会话
- 白名单控制，仅允许指定 Telegram 用户操作 bot
- 自动保存 `chat_id -> thread_id` 绑定关系，并同步线程名称和工作区映射到 Codex 桌面端索引
- `/start` 查看当前绑定状态，并在私聊里自动初始化首个会话
- `/new` 新建 Codex 线程
- `/current` 查看当前会话、线程 ID 和已选技能
- `/sessions` 分页浏览并切换当前工作目录下的已有会话
- `/skills` 按线程选择、取消和清空技能；技能选择会随会话持久化，并在后续回合自动注入
- 纯文本消息可直接进入当前线程；如果当前回合仍在进行，后续消息会通过 `turn/steer` 追加到同一回合
- 支持 Telegram `photo` 和图片类型 `document` 输入，图片 caption 会和图片一起提交给 Codex
- 自动下载 Telegram 图片到实例缓存目录，并定期清理过期临时文件
- 支持把 Codex 查看的本地图片、生成的图片，以及命令输出中新出现的图片回传到 Telegram
- 流式展示 Codex 的处理中状态、commentary 和最终回答，长消息会自动拆分
- 支持命令审批、文件修改审批，以及基础的 `request_user_input` 按钮/文本回复
- 使用 SQLite 持久化保存会话绑定、技能选择、Telegram update offset 和待处理交互
- 提供 `doctor` 自检命令和 `launchd` 常驻启动脚本

## 仓库与实例

这个仓库只保存功能本体。你自己的 bot token、白名单、工作目录、数据库、图片缓存和日志都应该放在仓库外的实例目录中。

推荐实例目录结构：

```text
~/.codex-telegram-bridge/
  instances/
    default/
      config.env
      data/
        bridge.db
        tg-files/
      logs/
      run/
```

这意味着你可以：

- 持续开发并把仓库同步到 GitHub
- 在同一份代码上维护多个 bot 实例
- 不把个人 token、绝对路径和运行数据提交进仓库

## 目录

- [src/index.ts](./src/index.ts): 主入口
- [src/bridge-service.ts](./src/bridge-service.ts): Telegram 和 Codex 的桥接逻辑
- [src/codex-app-server.ts](./src/codex-app-server.ts): 本地 `codex app-server` JSON-RPC 客户端
- [src/telegram.ts](./src/telegram.ts): Telegram Bot API 客户端
- [src/config.ts](./src/config.ts): 外部实例配置加载与路径派生
- [src/db.ts](./src/db.ts): SQLite 持久化
- [src/generated](./src/generated): 通过 `codex app-server generate-ts` 生成的协议类型
- [config.env.example](./config.env.example): 外部实例配置模板
- [launchd/install.sh](./launchd/install.sh): 安装 `launchd` 常驻服务

## 运行要求

- Node.js 24+
- 本机安装 Codex，并且 `codex app-server` 可用
- 本机 Codex 已登录，或者在实例配置里提供 `OPENAI_API_KEY`
- 这台机器可以访问 Telegram Bot API

## 快速开始

1. 安装依赖：

```bash
npm install
```

2. 编译：

```bash
npm run build
```

3. 创建实例目录：

```bash
mkdir -p ~/.codex-telegram-bridge/instances/default
```

4. 复制配置模板：

```bash
cp ./config.env.example ~/.codex-telegram-bridge/instances/default/config.env
```

5. 编辑 `~/.codex-telegram-bridge/instances/default/config.env`，至少填好：

```env
TELEGRAM_BOT_TOKEN=replace_me
TELEGRAM_ALLOWED_USER_ID=123456789
CODEX_WORKSPACE_CWD=/absolute/path/to/workspace
```

6. 先检查 Codex 侧：

```bash
npm run doctor:codex -- --instance default
```

7. 再检查 Telegram 侧：

```bash
npm run doctor:telegram -- --instance default
```

8. 一次性全量检查：

```bash
npm run doctor -- --instance default
```

9. 启动：

```bash
npm start -- --instance default
```

如果你更喜欢显式指定配置文件，也可以：

```bash
npm start -- --config ~/.codex-telegram-bridge/instances/default/config.env
```

## 配置说明

程序按这个顺序寻找实例配置：

1. `--config /path/to/config.env`
2. `CONFIG_FILE=/path/to/config.env`
3. `--instance <name>`
4. `INSTANCE_NAME=<name>`
5. 默认 `~/.codex-telegram-bridge/instances/default/config.env`
6. 如果默认实例配置不存在，会兼容读取当前目录的 `config.env` 或旧版 `.env`

配置值优先级：

1. 当前进程环境变量
2. 外部 `config.env`
3. 程序默认值

常用配置项：

- `INSTANCE_NAME`: 实例名称，默认 `default`
- `INSTANCE_ROOT`: 实例根目录；默认由实例名称推导
- `TELEGRAM_BOT_TOKEN`: Telegram bot token
- `TELEGRAM_ALLOWED_USER_ID`: 允许操作 bot 的 Telegram 用户 ID
- `CODEX_WORKSPACE_CWD`: 这个实例默认绑定的工作目录
- `CODEX_MODEL`: 可选；覆盖本机 Codex 默认模型，例如 `gpt-5.4`
- `OPENAI_API_KEY`: 可选；本机 Codex 未登录时的备用认证
- `TELEGRAM_PROXY_URL`: 可选；Telegram 代理
- `TELEGRAM_API_BASE_URL`: 可选；自建 Bot API 网关
- `DATABASE_PATH`: 可选；默认 `${INSTANCE_ROOT}/data/bridge.db`
- `TELEGRAM_FILE_DIR`: 可选；默认 `${INSTANCE_ROOT}/data/tg-files`
- `LOG_DIR`: 可选；默认 `${INSTANCE_ROOT}/logs`
- `RUN_DIR`: 可选；默认 `${INSTANCE_ROOT}/run`

## Telegram 中的使用

先给你的 bot 发：

```text
/start
```

常用命令：

- `/start`: 查看当前绑定状态
- `/new`: 新建一个 Codex 会话
- `/current`: 查看当前会话
- `/sessions`: 选择已有会话
- `/skills`: 选择当前会话技能

选中的技能会跟着 Codex 会话走，而不是跟 Telegram 聊天走；切换到别的会话时，会自动带出那个会话自己的技能选择。

如果你想发图片给 Codex，可以直接发送：

- 一张普通图片
- 或者把图片按“文件”形式发送，保留原图质量

如果图片带 caption，caption 会和图片一起进入当前回合。Codex 产出的本地图片也会回传到 Telegram。

## 群组使用

- 可以把 bot 拉进多个群组，每个群组绑定不同的 Codex 会话
- 新群组里建议先发 `/sessions` 选择已有会话，或者发 `/new` 新建一个
- bot 仍然只接受白名单用户的操作，其他群成员消息会被忽略
- 如果要让 bot 接收群里的普通文本或图片消息，通常需要在 BotFather 里关闭 privacy mode

## 常驻运行

先确保已经编译过：

```bash
npm run build
```

安装默认实例：

```bash
./launchd/install.sh --instance default
```

或者显式指定配置文件：

```bash
./launchd/install.sh --config ~/.codex-telegram-bridge/instances/default/config.env
```

卸载：

```bash
./launchd/uninstall.sh --instance default
```

默认日志路径：

- `~/.codex-telegram-bridge/instances/default/logs/bridge.stdout.log`
- `~/.codex-telegram-bridge/instances/default/logs/bridge.stderr.log`

## 常用命令

- `npm run dev -- --instance default`: 直接运行 TypeScript 版本
- `npm run build`: 编译到 `dist/`
- `npm run check`: TypeScript 类型检查
- `npm run doctor:codex -- --instance default`: 只检查 Codex 本地桥接
- `npm run doctor:telegram -- --instance default`: 只检查 Telegram token 和连通性
- `npm run doctor -- --instance default`: 同时检查 Telegram 和 Codex
- `npm run generate:protocol`: 重新生成 app-server 协议类型

## 网络说明

如果这台机器不能直连 Telegram，在实例配置里加上：

```env
TELEGRAM_PROXY_URL=http://127.0.0.1:7890
```

如果你不是走本地 HTTP 代理，而是走自己的 Bot API 网关，也可以设置：

```env
TELEGRAM_API_BASE_URL=https://your-gateway.example.com
```

## 排错

### `Missing required configuration`

说明当前实例配置文件缺少必填项，或者程序没有找到你的实例配置。

处理方式：

- 确认 `config.env` 存在
- 确认启动时使用了正确的 `--instance` 或 `--config`
- 对照 [config.env.example](./config.env.example) 补齐配置项

### `Telegram bot OK` 超时

大概率是这台机器连不到 `api.telegram.org`。

处理方式：

- 在实例配置里增加 `TELEGRAM_PROXY_URL`
- 或者设置 `TELEGRAM_API_BASE_URL` 指向你自己的中转

### `Codex is not authenticated`

说明桥接能起，但本机 Codex 没有可用认证。

处理方式：

- 先在桌面端或 CLI 里完成 Codex 登录
- 或者在实例配置里补 `OPENAI_API_KEY`

### `The model ... does not exist or you do not have access to it`

说明桥接请求的 Codex 模型当前账号不可用。处理方式：

- 在实例配置里设置 `CODEX_MODEL=gpt-5.4`
- 或者把本机 `~/.codex/config.toml` 里的 `model` 改成账号可用的模型

### 收到 `This bot is private.`

说明当前 Telegram 账号不在白名单里。

处理方式：

- 检查实例配置里的 `TELEGRAM_ALLOWED_USER_ID`
