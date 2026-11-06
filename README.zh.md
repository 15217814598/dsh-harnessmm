# dsh-harnessmm

把 HarnessMM（[arXiv 2610.32813](https://arxiv.org/abs/2610.32813)）搬进 DeepSeek Harness：
一个能读懂「动作库」的 `terminal` 工具，直接执行慢思考轮次里已经决定好的命令，
不再为每条 shell 命令额外付一次推理调用。

机制直接移植自 [HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)（Apache-2.0）
及其 [pi 扩展](https://github.com/jlon/pi-harnessmm)（Apache-2.0）：

| 机制 | 本插件位置 |
| --- | --- |
| `<CHISEL_PLAN>` 可执行决策图（EDG） | `bank.js`、`chisel_plan` 参数通道 |
| 受控决策复用（GDR） | `guard.js`、`admission.js`、`controller.js` |
| 可认证回调替换（CCS） | `controller.js` 里的 `certified-native-substitution/v1` 证书 |
| 编写指令 / 选择器提示词 | `policy.js` |
| 紧凑选择器状态与单字符裁判 | `admission.js`、`selector.js` |
| 基于先验的准入（策略 v8/v10） | `admission.js`（`admit`、`actionType`） |

## 工作方式

一次慢思考模型轮次同时给出「一个字面动作库」和一条根命令。`terminal` 先执行根命令，
然后沿着动作库前进：每个后继节点只要其 guard 在**紧邻的上一条真实回执**上成立，
就通过同一套 shell 接口执行，不再产生模型调用；每次执行都签发一张证书，证明它替换了
一次推理回调。

```text
模型轮次 N ── <CHISEL_PLAN> A→B→C  +  根命令
                ├─ 根命令执行 ──────────────► 回执
                ├─ A：guard(return_code==0) 成立 ──► 回执（无模型调用）
                ├─ B：guard(stdout_contains="PASS") 成立 ──► 回执（无模型调用）
                └─ C：动作库耗尽 ─────────────────► 回到慢思考
```

## 安装

本插件是零依赖、零构建的 profile bundle：

```text
plugin_manager  action: install_bundle  target: E:\project\dsh-plugin\dsh-harnessmm
```

bundle patch 会插入一行 `harnessmm` 配置。安装后立即生效；替换已安装包需要重启才能
加载新的模块代。

## 工具

`terminal` 与本机 shell 工具并列注册，但**所有**命令都通过本机 shell 工具
（Windows preset 为 `pwsh`，POSIX 为 `bash`）派发。因此工具注册表的执行前策略、
会话沙箱策略、审批、取消和后台任务处理对根命令和每个动作库命令都照常生效。
插件自己从不 spawn 进程。

参数：

| 参数 | 含义 |
| --- | --- |
| `command` | 根命令（必填） |
| `cwd` | 工作目录，默认会话工作区 |
| `timeout_sec` | 超过多少秒后终止 |
| `chisel_plan` | 可选的字面动作库（候选节点数组） |

每条命令的回执都是 `{return_code, stdout, stderr}`。非零退出会如实报告，不算工具失败。
模型看到的是裁剪后的输出；guard 与证书读取的是精确的原生回执。

## 怎么用

**日常使用不需要特殊语法。** 插件注入的提示词段落会让模型在「后续命令已经完全确定」
时自动编写动作库，你照常提需求即可；工具结果的第一行会是
`harnessmm: completed; 3 substitution(s) certified` 这样的计数。

**想先手动验证一次**，就在对话里点名工具和计划：

```text
用 `terminal` 工具（不要用 pwsh），带一个 `chisel_plan`：根命令跑 `echo root-ok`，
然后 `echo A-ok`，再 `echo B-ok`，其中 B 的 guard 要求 stdout 含 "A-ok"。
把你收到的 harnessmm 那一行原样贴出来。
```

预期结果——一次工具调用、三条回执、两张证书：

```text
harnessmm: completed; 2 substitution(s) certified
bank: 2 candidate(s) from argument (graph …)
receipts:
root {"return_code":0,"stdout":"root-ok…","stderr":null}
A {"return_code":0,"stdout":"A-ok…","stderr":null}
B {"return_code":0,"stdout":"B-ok…","stderr":null}
```

想测文本通道，改成：*「在你的消息正文里写且只写一个 `<CHISEL_PLAN>` 块，然后调用
`terminal` 时不带 `chisel_plan`。」*

审计入口：

- 输入框里的 `/harnessmm`：当前会话计数（`/harnessmm clear` 清空）。
- `/api/dsh-harnessmm`：账本面板（在**已登录该 GUI** 的浏览器里打开；Host 的 HTTP
  路由要求 GUI 鉴权）。
- `/api/dsh-harnessmm/status`、`/api/dsh-harnessmm/ledger?sessionId=…`：JSON。

## 怎么验证

### 离线：不启动 Harness、不调用模型

```bash
cd dsh-harnessmm
node scripts/selftest.mjs      # 11 项端到端检查，并打印模型可见报告
node --test test/*.test.mjs    # 51 个单元/集成测试
```

`selftest.mjs` 用假工具注册表 + 假实时会话跑**真实编排代码**
（`tools.js` → `bank.js` → `guard.js` → `admission.js` → `controller.js`），断言：

| 检查 | 证明了什么 |
| --- | --- |
| 文本动作库：链被执行 | 文本通道的 A→B 链跑通并报告 `completed` |
| 每个后继一张证书 | 每次执行恰好一条 `certified-native-substitution/v1` |
| 证书写明被跳过的回调 | `…:omitted:2` 且 `slow_requests_at_boundary: 0` |
| 无会话日志时的参数通道 | `chisel_plan` 不依赖会话日志也能工作 |
| guard 不成立 | 控制权回到模型，什么都不执行 |
| 非法动作库 | 根命令照常执行，并报告违约原因 |
| 选择器 | 两个候选时由裁判选一个，并计量用量 |
| 报告 | 模型可见文本包含结果、动作库与全部回执 |
| 裁剪 | 模型只看到有界尾部，guard 读到精确回执 |

### 在线：在运行中的 GUI 里

1. 发上面那条「点名验证」的提示。工具卡片应显示三条回执和 `harnessmm:` 那一行。
2. 输入 `/harnessmm`——`banks authored` 与 `certified substitutions` 会增加。
3. 打开会话顶部的「节省」标签页（「编队」右侧），能看到本会话的证书行；
   同源 `/api/dsh-harnessmm` 是等价的 HTML 兜底。
4. 证明真的省掉了模型调用：**同一个助手步骤**就产出了 `root`、`A`、`B` 三条回执，
   且每张证书都带 `bypassed_slow_callback_id: "<编写调用>:omitted:N"` 和
   `slow_requests_at_boundary: 0`。

### 反例（机制会失败关闭）

| 尝试 | 预期 |
| --- | --- |
| 候选重复根命令 | `bank rejected: A future candidate cannot repeat…`，结果 `invalid_bank`，根命令仍执行 |
| guard 用了永不出现的标记 | 结果 `deferred`，`control returned to the model: no_eligible_or_unexpected_receipt` |
| 参数含 `${VAR}` | 按未解析占位符拒绝 |
| guard 写 `task_solved` / `code_correct` | 拒绝：guard 只读回执 |
| 两个后继都满足 | 裁判选一个标签（selector tokens > 0），或弃权回模型 |
| 链中任一命令非零退出 | 立即停止，最后一条回执带退出码，结果 `failed` |

## 编写契约

每个轮次只能在**一个**通道里写动作库：`chisel_plan` 参数，或同一轮助手文本里的
一个 `<CHISEL_PLAN>{"candidates":[...]}</CHISEL_PLAN>` 块。两者同时出现视为违约。

```json
{
  "candidates": [
    {
      "candidate_id": "A",
      "predecessor_id": "root",
      "tool": "terminal",
      "arguments": { "command": "npm run build" },
      "guard": { "return_code": 0 },
      "required_receipt_fields": ["return_code"],
      "expected_local_cost": { "selector_upper_tokens": 2048 },
      "dependency_ids": []
    },
    {
      "candidate_id": "B",
      "predecessor_id": "A",
      "tool": "terminal",
      "arguments": { "command": "npm test" },
      "guard": { "return_code": 0, "stdout_contains": "PASS" },
      "required_receipt_fields": ["return_code", "stdout"],
      "expected_local_cost": { "selector_upper_tokens": 2048 },
      "dependency_ids": ["A"]
    }
  ]
}
```

`bank.js` 强制的规则：

- `candidate_id` 是 `A..P` 内唯一的单字母；`predecessor_id` 为 `"root"` 或更早的 id；
  `dependency_ids` 只能引用 `"root"` 或已声明的 id。
- 节点字段闭合。guard 键只允许 `return_code`、`stdout_contains`、`stdout_equals`、
  `stderr_empty`、`json_equals`。
- 每个 guard 字段都必须出现在 `required_receipt_fields` 中，避免 guard 读取回执可能
  不包含的字段。
- `arguments` 必须完全字面（`command`、可选 `cwd`、可选 `timeout_sec`）；拒绝
  `${...}`、`{{...}}` 占位符，拒绝重复已经执行过的根命令。
- 每轮恰好一个动作库、恰好一个根工具调用；节点数不超过 `maximum_candidates`。

## 准入

| 策略版本 | 准入 |
| --- | --- |
| 6 | 确定性净节省阈值（`net > 1024`）；只有一个候选满足时直接提交，不调用选择器 |
| 7 | 确定性准入，但无净节省阈值 |
| 8、10 | 基于先验：必须存在冻结的 TRAIN 类目中位数，且快路径不超过其四分之一；缺少先验时**失败关闭** |

节省估计取编写轮次记录下来的 `usage.totalTokens`。会话日志不可用时跳过阈值而不是
拒绝全部候选（账本里会记录估计口径）。

多个候选同时满足时，用**编写该动作库的同一 provider/model** 做单字符选择器：返回
候选标签之外的任何内容都视为弃权，控制权回到模型。选择器提示词与紧凑状态沿用上游。

## 证书与账本

每次替换都会写入 `certified-native-substitution/v1`：

```json
{
  "schema": "certified-native-substitution/v1",
  "bank_sha256": "...", "candidate_id": "B",
  "bypassed_slow_callback_id": "call_abc:omitted:2",
  "predecessor_callback_id": "chisel_..._A",
  "graph_hash": "...",
  "exact_native_tool": "terminal",
  "exact_arguments": { "command": "npm test" },
  "native_receipt_hash": "...", "native_receipt": { "return_code": 0, "stdout": "...", "stderr": null },
  "guard": { "return_code": 0, "stdout_contains": "PASS" },
  "native_action_hash": "...",
  "slow_requests_at_boundary": 0,
  "slow_sequence_before": 0, "slow_sequence_after": 0,
  "valid_substitution": true
}
```

证书绑定精确参数、精确回执，以及「期间没有发生慢请求」。它不声称任务正确，
也不声称反事实 token 数。

可用界面：

- 应用内界面（web 客户端）：会话标签栏中「编队」右侧的 **「节省」** 标签页——
  四张节省卡（含净节省）、本会话与全部会话的估算节省、**会话选择器（按项目分组）**、
  逐张证书的命令/guard/精确回执/节省 token、原始事件流；注册为 `conversation.view`
  列表项（`order: 40`，编队为 30），数据来自同源 `/api/dsh-harnessmm/*`。
- 会话选择器按**会话所属项目**（会话头部的 `cwd`）分组，组标题给出该项目累计节省；
  单条证书仍归属于产生它的会话，项目只是分组视图。
- `/harnessmm`：当前会话计数与估算节省（`/harnessmm clear` 清空）。
- `GET /api/dsh-harnessmm/status`：策略、工具、shell 目标、各会话计数（含
  `estimated_saved_tokens`）。
- `GET /api/dsh-harnessmm/ledger?sessionId=…`：全部保留事件 + 每次替换的节省明细
  （`substitutions`）。
- `DELETE /api/dsh-harnessmm/ledger[?sessionId=…]`：清空单个会话或全部。
- `GET /api/dsh-harnessmm`：同源 HTML 版节省仪表盘（无客户端 bundle 环境的兜底）。

节省估算是一个可见的代理，不是反事实断言：每次替换的节省按编写轮次的
`usage.totalTokens` 减去归因到它的选择器开销计（`estimated_saved_tokens`）；选择器
弃权花掉的 token 计入 `selector_tokens_lost`，绝不计作节省。会话日志不可用时慢调用
token 按 0 计，估算因此也是 0。

账本默认持久化在 `$DSH_HOME/storages/harnessmm/ledger.jsonl`（默认
`~/.dsh/storages/harnessmm/ledger.jsonl`，JSONL、每个事件一行），重启后自动回填，
所以历史会话仍能在「节省」标签页里选到。它记录的是**证书**（命令、guard、回执片段、
节省 token），这些内容因此会写到本地磁盘；`persist: false` 可退回纯内存。
启用插件之前的对话无法回填——证书是运行时事实，不做事后推断。

## 配置

```yaml
- insert:
    - id: harnessmm
      name: 'dsh-harnessmm-plugin'
      config:
        enabled: true
        policy:
          version: 6
          maximum_candidates: 16
          maximum_fast_steps: 8
          maximum_public_bytes: 65536
        shellTool: ''          # '' = 依次探测 pwsh → bash → shell
        maxReceiptBytes: 8192  # 每条流模型可见的字节数
        selector:
          enabled: true
          maxTokens: 256       # 推理模型会先用掉一些 token 才给出标签
          temperature: 0
        persist: true          # 把账本落到本地 JSONL（关掉则纯内存）
        storagePath: ''        # '' = $DSH_HOME/storages/harnessmm/ledger.jsonl
        priors: null           # 版本 8、10 必需
```

所有键闭合，加载时校验。`priors` 接受冻结的 TRAIN 表：
`{phase:'train', categories:{inspect:{phase:'train', median_tokens:12000}}}`。

## 与参考实现的差异

以下差异是有意为之，且都在代码与测试中可见：

1. **两通道、一个动作库**：同时支持 `<CHISEL_PLAN>` 文本与 v10 的 `chisel_plan`
   参数；同一轮同时声明两者会被拒绝。
2. **只接受节点形态契约**：支持 6、7、8、10 版；不接受 v6 之前的
   `{label, after, condition}` 形态。
3. **净节省阈值需要真实慢调用用量**：没有会话日志时跳过阈值，账本记录口径，
   绝不静默拒绝所有候选。
4. **应用先验的四分之一规则**：参考实现的控制器传 `fullSAR = version === 6`，
   从而绕过它自己在 v8/v10 文档里声明的四分之一规则；本插件按文档执行。
5. **动作库保留在对话记录中**：不做 HarnessMM 的公开历史压缩（`compactSession`）。
   dsh 的 surface 重写属于 compaction 服务，在工具执行中途改消息不安全。
   因此动作库在后续轮次仍占 token；但每次替换依然省掉了对应的推理回调。
6. **原生派发而非私有进程**：每条命令都走已注册的 dsh shell 工具，
   审批与沙箱对动作库命令同样生效。
7. **选择器没有 logprobs**：验证输出形态，与 pi 移植版一致；但裁判拿到的是
   较小的 token 预算而不是 1 个 token，因为推理模型会先消耗一些 token 才给出
   单字符答案。只接受单独标签（可带尾随标点），任何散文都视为弃权。

## 开发

```bash
cd dsh-harnessmm
node --check index.js client.js bank.js guard.js admission.js controller.js receipt.js session.js ledger.js shell.js tools.js routes.js store.js selector.js policy.js
node --test test/*.mjs
```

测试用假的工具注册表和假的实时会话跑真实编排逻辑，不需要启动 Harness 或调用模型；
`test/client.test.mjs` 用桩 ModuleLoader 与桩 React 验证客户端模块的注册契约。

改 `client.js` 后需要重启宿主才会重新载入：`./client` 导出路径就是浏览器模块身份，
若要不重启热替换，把新版本另存为 `client.v2.js` 并更新 package.json 的导出路径。

`__ModuleLoader__.load({ id })` 的 `id` **必须等于 package.json 的 `name`**。加载器按包名
登记 factory；id 不一致时它会认为该 row 没注册成功，改用单资源 URL 再执行一次 bundle，
第二次就在 `duplicate factory registration` 处让整个 web boot 失败（`test/client.test.mjs`
里有断言防止回归）。

## 许可

Apache-2.0。上游署名见 [NOTICE](NOTICE)。
