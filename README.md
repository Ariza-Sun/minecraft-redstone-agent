# minecraft-redstone-agent (mc-ic)

一个在 Minecraft 里设计、搭建并验收红石组合逻辑电路的 LLM 智能体，附带 React 工作台。

你用自然语言描述一个电路（例如"搭一个双输入与门"），智能体依次产出三份结构化产物，每一份都由确定性程序检查，最后在真实的 Minecraft 世界里逐行验证真值表：

```text
自然语言请求
  → TaskSpec        输入/输出端口、真值表、工作区、可用方块（Schema + 语义校验）
  → LogicDesign     逻辑门网表（按完整真值表做确定性检查）
  → 人工确认
  → PhysicalLayout  每个方块的坐标与 blockstate（结构校验 + 红石真值表模拟）
  → 自动修补或人工引导 → 重新检查与模拟
  → /setblock 逐块搭建并读回
  → 在 Minecraft 中切换拉杆、读取红石灯，得到验收报告
```

整条链路只有一个 LLM。它负责设计和修改；Schema 校验、逻辑检查、布局校验、模拟、搭建、观察和判定都是确定性程序。布局提示词里注入的是通用的方块物理与红石实现知识，没有固定坐标的门电路模板，也没有针对具体任务的布局编译器。

只支持组合逻辑：没有时钟、锁存器或依赖历史的行为。

## 快速开始：离线演示

不需要模型，也不需要 Minecraft。用内置的 NOT 门样例跑通状态机、界面和落盘：

```bash
npm install
npm run dev:demo
```

打开 `http://localhost:5173`。这个模式下的产物来自代码内的预置样例，Minecraft 是进程内的模拟适配器，所有记录都标记为 `authoritative: false`，终态是 `COMPLETED_NON_AUTHORITATIVE`。它不能作为电路可用的证据。

需要 Node.js 20 或更高版本。

## 接入真实模型和 Minecraft

### 1. 启动 Minecraft 服务器

使用 Minecraft Java 版 1.20.4 的官方 `server.jar`（需要 Java 17 以上）。首次启动后把 `eula.txt` 改成 `eula=true`，并在 `server.properties` 中设置：

```properties
online-mode=false
level-type=minecraft:flat
spawn-protection=0
```

再次启动服务器，然后在服务器控制台给机器人账号管理员权限：

```text
op RedstoneBot
```

机器人以离线模式登录，用 `/setblock` 搭建，所以必须有 OP 权限。账号名由 `MC_USER` 决定。

### 2. 配置模型

```bash
cp .env.example .env.local
```

在 `.env.local` 里填入 `OPENROUTER_API_KEY`。模型请求走 OpenRouter 的 Chat Completions 接口；`OPENROUTER_BASE_URL` 可以换成其他兼容该接口的服务。`.env.local` 已被 `.gitignore` 排除。

可选模型由 `src/domain/model-catalog.ts` 里的白名单决定，浏览器不能提交白名单以外的模型。目录中的模型和参考价格会过时，使用前请对照 OpenRouter 自行核对并按需修改。

### 3. 运行

```bash
npm run dev
```

- 工作台：`http://localhost:5173`
- API：`http://localhost:8787`
- 嵌入的 Minecraft 实时画面经工作台同源代理提供，不需要单独开放端口

生产构建：

```bash
npm run build
npm start
```

此时 API 进程同时托管前端，入口是 `http://localhost:8787`。

实时画面依赖可选的原生包 `canvas` 和 `prismarine-viewer`。装不上时设 `MC_VIEWER_ENABLED=false`，搭建和验收不受影响。

## 代码结构

```text
src/
├── domain/      产物与事件的类型和 Schema、方块能力表、模型目录
├── platform/    配置、运行记录落盘、HTTP Basic Auth
├── agent/
│   ├── controller/  会话状态机、布局修补循环、反馈整理
│   ├── model/       模型适配器、提示词、格式容错、布局俯视图
│   ├── knowledge/   注入提示词的方块物理与电路实现知识卡
│   └── tools/       逻辑检查、布局校验、红石稳态模拟、真值表验收
├── minecraft/   Mineflayer 实机适配器、模拟适配器、实时画面
├── host/        Express API 与进程入口
└── web/         React 工作台
```

几个值得先读的文件：

- `src/agent/controller/session-controller.ts`：整条链路的状态机。
- `src/agent/model/openrouter-adapter.ts`：各阶段的提示词和请求、重试、格式校验逻辑。
- `src/agent/tools/redstone-simulator.ts`：按原版规则实现的红石稳态模拟器。
- `src/agent/tools/layout-validator.ts`：布局的结构检查，以及调用模拟器的入口。

## 布局校验与模拟

布局先过结构检查：边界、方块白名单、blockstate、坐标唯一、端口位置、附着支撑、逻辑 ID 映射。没有结构问题时，再用模拟器把候选布局按完整真值表跑一遍。

模拟器实现了本项目方块目录的稳态行为：拉杆、两类红石火把、红石线、中继器、比较器、红石灯、实体方块、玻璃、红石块，以及环境生成的草地。它处理强充能与弱充能、火把只对挂载块反应、红石线形状决定供电方向、红石线的上下台阶连接，以及火把烧毁。

每一行结果不符的真值表用例都会成为一条 `SIMULATED_CASE_MISMATCH`，消息里写明该行观测到的灯状态、灯的每个相邻方块为何供电或不供电，以及全电路的观察（例如某个火把在所有用例中都常亮）。这些诊断会原样反馈给模型。

模拟不替代实机验收。只有连接真实 Minecraft 得到的 `SUCCEEDED` 才算电路通过。`RUN_LAYOUT_SIMULATION=false` 可以关闭模拟门控，用于排查模拟器与真实服务端不一致的情况。

## 布局修补循环

第一个候选布局用 `propose_layout` 完整生成。之后每次尝试都用 `repair_layout` 提交局部补丁（新增、替换或删除若干方块），控制器保留未提及的方块，生成新版本并重新校验。

候选按"结构问题数、错误输出位数、失败行数"依次比较。没有改善的候选会被回滚，下一次尝试仍从当前最佳候选出发。修补提示词里附有最佳布局的逐层俯视图，让模型直接看到相邻关系。

每轮默认最多 5 次尝试（`RUN_MAX_LAYOUT_VERSIONS`）。用完后由人决定是否再开一轮，开新一轮时可以附一段文字建议。布局通过后停在 `READY_TO_BUILD`，由人点击开始搭建。实机验收失败后本次会话结束，报告与记录保留。

## 运行记录

每个会话写入 `runs/<session-id>/`：

```text
manifest.json
events.jsonl          只追加的事件流，seq 严格递增
artifacts/            各版本的 TaskSpec、LogicDesign、PhysicalLayout、BuildRun、VerificationReport
model/                每次模型调用的请求与响应
evidence/
```

模型请求记录不含请求头，落盘层还会对 Authorization 和 API key 形态的内容再做一次脱敏。`runs/` 已被 `.gitignore` 排除。

## API

```text
POST /api/sessions
GET  /api/sessions/:id
GET  /api/sessions/:id/events?after=<seq>         JSON 或 SSE
POST /api/sessions/:id/commands/approve-design
POST /api/sessions/:id/commands/revise-layout     body: { instruction?: string }
POST /api/sessions/:id/commands/retry-layout      body: { instruction?: string }
POST /api/sessions/:id/commands/start-build
POST /api/sessions/:id/commands/show-case         body: { caseIndex }
POST /api/sessions/:id/messages
GET  /api/sessions/:id/artifacts
GET  /api/artifacts/:artifactId/versions/:version
```

## 测试

```bash
npm test
npm run typecheck
```

测试不需要模型或 Minecraft，覆盖逻辑检查、布局校验、模拟器、模型适配器的请求与格式容错，以及一次完整的非权威会话。

## 安全

- API 会消耗你的模型额度并操作 Minecraft 服务器。默认不带认证，只适合本机或可信网络。
- 要暴露到公网，必须同时设置 `WEB_AUTH_USER` 和 `WEB_AUTH_PASS` 启用 HTTP Basic Auth，并放在 HTTPS 之后。
- `npm audit` 报告的部分告警来自 Mineflayer 的微软在线认证传递依赖。本项目固定使用离线登录，不会走到那条路径；不要按 `npm audit fix --force` 的建议降级 Mineflayer，那会破坏协议支持。

## 许可证

[MIT](LICENSE)
