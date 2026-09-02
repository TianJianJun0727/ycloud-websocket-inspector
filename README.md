# YCloud WebSocket 监听器

用于本地监听 SharedWorker WebSocket 消息的 Chrome 扩展。它不会修改业务页面、
业务 WebSocket 或业务页面存储；捕获记录只保存在扩展自身的 IndexedDB。

## 本地安装

1. 打开 Chrome 的扩展程序页面：chrome://extensions。
2. 打开右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `bun run build` 生成的 `.output/chrome-mv3` 目录。
5. 打开使用 SharedWorker 的业务页面，再点击工具栏中的扩展图标。

Chrome 会显示调试器相关提示，这是 chrome.debugger 权限的正常安全提示。关闭
Inspector 页面约 5 秒后，扩展会主动断开全部调试目标；重新打开页面会再次扫描。

## 使用

- 插件自动扫描并校验 SharedWorkerGlobalScope，只保留真正的 SharedWorker。
- 左侧选择某一次 WebSocket 连接，右侧只展示该连接的时间、方向、大小和消息预览，避免依赖
  YCloud 业务事件格式。
- 每个 request ID 对应一次独立连接和独立消息缓存；方向、文本筛选、清空和导出都只作用于当前连接。
- 当前连接的搜索、方向、清空和导出集中在右侧连接工具区；顶部只保留重新扫描和主题等全局操作。
- 列表默认按捕获时间正序展示，上行和下行按真实时间交错；点击“时间”表头可切换倒序。
- 主题入口位于顶部全局工具区，以图标切换跟随系统、亮色和暗色，选择结果保存在扩展自身的本地存储中。
- 文本筛选支持普通包含匹配，也支持 `/pattern/flags` 形式的正则表达式。普通文本会匹配当前连接的 URL、SharedWorker URL 和消息正文；正则只匹配消息正文，flags 按输入原样生效。
- 连接列表显示连接开始时间、结束时间或“至今”，以及连接中/记录中/暂停/关闭状态。
- 左侧连接区宽度和下方消息详情区高度可通过分隔条拖拽调整；消息表格使用固定列宽。
- “连接概览”是只读汇总，不参与筛选；可在这里暂停或开始全部记录。每个连接也可独立控制，暂停只影响插件记录，不会暂停或断开业务 WebSocket。
- 时间使用本地时区的 `YYYY-MM-DD HH:mm:ss.SSS` 格式，跨天查看时不会混淆。
- “跟随最新”开启时会在新批次到达后自动滚动到消息列表底部。
- “清空当前”只清除当前连接的缓存，不影响其他连接；由于监听仍在继续，新消息会立即开始累计。
- 如果插件在 WebSocket 已经建立之后才连接，仍可能捕获后续帧，但 URL 可能要等业务
  WebSocket 重连后才能从 webSocketCreated 事件中识别。插件会先通过 Runtime
  查询现存 WebSocket 对象；仅在一个未知连接能与一个现存对象唯一对应时补全真实 URL，
  无法唯一对应时使用 SharedWorker 地址和 request ID 作为稳定标识，不猜测 URL。
- 调试期间不要同时为同一个 SharedWorker 打开 DevTools，它们会竞争同一调试目标。

## 数据与容量边界

- 数据按 WebSocket 连接实例分别保存在扩展自身的 IndexedDB；不写业务页面存储，也不上传。刷新或重新打开 Inspector 会开始新的监听会话，同时清空上一会话的消息、连接实例、诊断和暂停状态；不会中断业务 WebSocket。
- 全局最多保留 10,000,000 条，超过后从最早消息开始淘汰。
- 单个 WebSocket 最多保留 1,000,000 条，避免一个高流量连接挤掉其他连接的全部记录。
- 不再设置应用内 payload 总字节上限；实际容量仍受 Chrome 为扩展分配的 IndexedDB 配额和设备可用内存限制。
- 单条 payload 最多保留 1 MB，超出部分标记为截断。
- 页面表格通过固定行高虚拟化展示当前连接的全部保留记录；左侧数量与未筛选表格总数一致，DOM 只保留可视行和少量缓冲行。
- “清空当前连接”会同时删除该连接在内存和扩展 IndexedDB 中的记录。卸载扩展也会删除扩展存储。
- 后台以最多 64 条或 70ms 为一个批次向 Svelte UI 传输，降低高流量时的扩展消息与
  重渲染开销。
- 顶部“存储异常”仅表示扩展 IndexedDB 初始化或写入失败；SharedWorker 调试连接、扫描
  或 WebSocket frame 错误短时显示为“监听异常”，连接/帧恢复或 10 秒后自动消失，悬停可查看原始错误信息。

## 本地验证

运行：

    bun test tests/*.test.mjs

也可以通过 inspector.html?demo=1 打开不连接调试器的 UI 演示模式。演示模式只用于
视觉验证；实际捕获能力必须在加载扩展后，以真实 SharedWorker WebSocket 进行验证。

## UI 开发

项目使用 WXT、Svelte 5、TailwindCSS v4 和 DaisyUI。首次开发先运行 `bun install`，启动开发模式：

    bun run dev

生产构建运行 `bun run build`，然后在 Chrome 中加载 `.output/chrome-mv3`。Inspector 入口位于
`src/entrypoints/inspector`，后台入口位于 `src/entrypoints/background.ts`。

## 设计参考

高流量批处理、按连接管理和可调整详情面板参考了开源项目
[websocket-devtools](https://github.com/law-chain-hot/websocket-devtools) 的设计思路。
本工具不会采用其页面注入、消息模拟、阻断、自动去重或高流量自动停监控能力，因为
这些行为会改变或丢弃用于一致性验证的原始 WebSocket 消息。
