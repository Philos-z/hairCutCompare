# 可选 AI 辅助服务

Web 的导入、校准、轮廓编辑、量化和导出均可在不启动此服务时使用。AI 仅在用户主动点击后提供拍摄质量建议及已有指标的文字解释；它不能更改本地轮廓、变换、测量值或质量状态。

## 启动

在工程根目录执行：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
```

在 `backend/.env` 中填写 `OPENAI_API_KEY`；如需限制访问，设置 `RESEARCH_ACCESS_TOKEN`。然后启动：

```bash
backend/.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --env-file backend/.env
```

前端默认 AI 服务地址为 `/ai-proxy`，通过 Vite 在本机转发到 `http://127.0.0.1:8000`；研究访问令牌填写 `RESEARCH_ACCESS_TOKEN` 的值。前端不接收 OpenAI API 密钥。使用其他部署时，可以填写该部署的 HTTP/HTTPS 服务地址。

服务地址保留路径前缀：例如 `https://example.test/research/api/` 会请求 `https://example.test/research/api/v1/comparison-assistance`。使用 Vite 的同源 `/ai-proxy` 代理时，可填写 `/ai-proxy` 或完整的网页来源加该前缀；例如 `https://192.168.1.50:5174/ai-proxy`。浏览器向 HTTPS 网页自身请求，Vite 在本机转发到 `http://127.0.0.1:8000`，后端可以继续只监听本机。

默认准确允许本机 HTTP Vite 开发来源（`localhost` / `127.0.0.1` 的端口 `5173`）、HTTPS 开发来源（端口 `5174`，同时保留 `5173`）及 HTTP/HTTPS 预览来源（端口 `4173`）。iPhone 跨设备测试需在 `ALLOWED_ORIGINS` 中添加实际网页的 HTTPS 来源；例如 Mac 的 LAN IP 为 `192.168.1.50` 时，追加 `,https://192.168.1.50:5174`，来源不含 `/ai-proxy` 或末尾斜杠。协议、IP/主机及端口必须全部匹配；不使用 `*`。不经过同源代理时，HTTPS 页面必须调用 HTTPS 服务。

默认固定模型为 `gpt-4.1-mini-2025-04-14`，可以通过服务端 `OPENAI_MODEL` 配置。`GET /health` 只返回 `{"ready": true}` 或 `{"ready": false}`，表示是否已填写密钥，并不验证账户权限或额度。

## 数据与限制

- 前端从选定的两张、已统一方向的照片中裁出头部，缩放到最长边不超过 `1280` 像素，再输出不含 EXIF 的 JPEG。
- 发送图片、当前视角、本地质量检查、可用指标、已有姿态/亮度信息和算法版本；不发送保存名称、文件名、项目备注或无关照片。缺少可靠头部标记时先要求补充标记。
- 此服务仅在内存中处理请求，不保存图片或请求内容，不打印上传、密钥或上游错误详情。请求最大 `6 MiB`，单张图片最大 `2 MiB`、边长最大 `2048`；只接受真正的 JPEG / PNG / WebP 静态图片。
- 调用 [OpenAI Responses API](https://developers.openai.com/api/docs/guides/images-vision)，以 `store:false` 请求，并使用 [严格结构化输出](https://developers.openai.com/api/docs/guides/structured-outputs)。此选项不等于零数据保留，云端处理仍受 [OpenAI 数据控制规则](https://developers.openai.com/api/docs/guides/your-data) 约束。
- AI 文字不能包含重新推测的数值或尺寸。区域说明的 `metricId` 必须引用本地现有指标，或者为 `null`。本地指标可含 `projection.widthChangePercent` / `heightChangePercent`，描述当前轮廓相对喜欢轮廓在参考图像平面的投影宽度/高度百分比变化。AI 可以解释变化方向与含义，具体数值由本地界面展示；`null` 表示该方向不可量化，不能补全，也不能换算成真实发长、体积或剪发尺寸。回答包含非法结构、未知指标、数字尺寸、拒绝或截断时，服务返回错误，不覆盖本地结果。
- 浏览器请求总超时 `45` 秒；服务上游调用最长 `40` 秒，同时处理至多两次调用、不自动重试。断网或 AI 不可用时，本地流程继续。

## 接口

`POST /v1/comparison-assistance`，`Content-Type: application/json`；配置研究令牌时需要 `Authorization: Bearer <研究令牌>`。

```typescript
type Request = {
  schemaVersion: 1;
  inputDigest: string; // 输入版本的 SHA-256，64 位十六进制
  view: 'front' | 'left' | 'right';
  referenceImage: string; // data:image/jpeg;base64,... 等
  currentImage: string;
  quality: QualityResult;
  metrics: RegionMetric[]; // 非 comparable 时必须为空
  captureInfo?: { reference: CapturePhoto; current: CapturePhoto } | null;
};
```

成功返回 `src/core/types.ts` 的 `AIAdvice`，`model` 和 `inputDigest` 由服务端绑定。错误统一返回：

```json
{"detail":{"code":"ai_timeout","message":"AI 请求超时，请稍后重试。本地对比仍可使用。"}}
```

前端原生 fetch 适配器位于 `src/ai/client.ts`，导出 `requestAdvice(project, quality, metrics, {baseUrl, token?, signal?})` 和 `getInputDigest(project)`。照片、标记、喜欢照片、视角、显示设置或备注变化都会改变输入指纹。React 中必须在请求完成时与**最新项目**的指纹核对，已有解释与新指纹不同时标记为过期。

## 验证

```bash
backend/.venv/bin/python -m pytest backend/tests -q
```

测试完全模拟上游，不使用密钥或产生 API 费用。覆盖图片类型/尺寸、输入结构和指纹、研究访问令牌、来源限制、无持久化和无图片回显、非法指标/数值、缺少配置、超时、限额、拒绝和截断。真实账户的模型访问和视觉输出质量须在用户提供配置后单独验证。
