# 发型参照 · Web 首版

中文 2D 发型对比工作台。导入同一个人的两张同视角照片，标记一张“喜欢”，确认其发型轮廓，再用面部锚点校正另一张照片。绿色参考线固定，当前头发不参与配准。

已交付 React + TypeScript + Vite 工程、同源 MediaPipe 模型/WASM、`dist/` 静态构建、可选 FastAPI AI 服务、绘制演示数据、浏览器与算法验证，以及可重复评估样本。默认研究用途、浏览器本地保存，未公开部署。顾客管理、实时取景、LiDAR 和 3D 留待后续。

## 本地运行

推荐 Node.js 22.12+；本次使用 Node 25.4 和 Python 3.14。在本目录执行：

```bash
npm ci
npm run models:prepare
npm run dev
```

电脑 Chrome / Safari 打开 **http://localhost:5173**。页面右上方“体验示意图”可直接体验校正与轮廓差异。演示图明确标记为绘制示意，不代表真人测量精度。

```bash
npm run build
npm run preview
```

静态构建输出在 `dist/`，预览地址为 **http://localhost:4173**。需要通过 HTTP/HTTPS 服务访问，直接双击 `dist/index.html` 无法启动模块和 Worker。模型及 WASM 已随构建复制，无需运行时 CDN。

## iPhone Safari

电脑与手机连接同一 Wi-Fi。在电脑启动：

```bash
npm run dev:https
```

脚本需要支持 `-addext` 的 OpenSSL（1.1.1+），在 `.cache/certs/` 生成仅用于本机开发的 CA 和包含当前 LAN IP 的服务证书，打印 `https://电脑IP:5174`。脚本不安装系统信任，不上传证书，不公开部署。

1. 用 AirDrop 等方式把 **`.cache/certs/local-ca.cer`** 传到自己的 iPhone；私钥 `.key` 文件留在电脑。
2. 在 iPhone 设置中安装下载的证书描述文件，再到“通用 → 关于本机 → 证书信任设置”启用该开发 CA 的完全信任。
3. Safari 打开终端打印的 HTTPS 地址。Mac Safari 测试同一地址时，可在钥匙串中手动导入并信任该 CA。
4. 完成开发后可移除手机描述文件与信任。LAN IP 改变后重新运行脚本；服务证书会按新 IP 更新。证书有效期一年，过期后移除 `.cache/certs/` 并重新生成、安装。

HTTPS 是跨设备使用 Web Crypto 和完整 Worker 能力的必要条件。未信任的证书或 LAN HTTP 访问不能视为完整手机测试；页面提供人工回退和明确的项目校验错误。

文件选择器支持相册或系统提供的拍照入口；不做实时摄像头分析。JPEG、PNG、WebP 可导入；HEIC/HEIF 尝试 Safari 原生解码，失败时提示先转换成 JPEG/PNG。每张照片上限 25 MB / 8000 万像素，分析副本最长边 2048px。较小照片更适合手机内存。

## 操作与保存

- 选择两张照片，标记“喜欢”；进入“确认轮廓”，分别检查外轮廓、刘海下缘与左右鬓角。外轮廓是开放曲线，无需闭合。
- 在轮廓编辑器拖动点、重新描线、增删节点或撤销，支持 Pointer Events 鼠标与触控。自动刘海/鬓角只是候选，缺失部分需要手工补画。
- 两张照片使用对应的眼睛、鼻尖、下巴锚点。侧脸可移除遮挡的眼，至少保留三个分布充分的可见对应点。调整锚点后重新求旋转、平移、等比缩放；不会对头发进行形变拟合。
- 确认双方轮廓、面部对齐、转头/仰俯及拍摄距离后查看可靠区域指标。明显姿态不匹配显示参考照片并引导重拍。被画面裁切或缺失的区域不提供指标。
- 可显示橙色当前线、叠加参考照片、调透明度、缩放或查看原图。“导出对比图片”始终输出校正后的比较图，合成选中的轮廓图层、状态、完整备注与指标。
- “保存喜欢基准”保存参考照片及标注；“保存项目”保存完整对比。记录在当前浏览器的 IndexedDB，重新打开已命名基准时可以保留当前待比较照片。
- “项目文件”导出包含原图与分析副本、SHA256 校验、标注及状态的 `.haircompare.json`；“打开项目文件”用于恢复和迁移。建议定期导出，清除网站数据或浏览器存储回收会丢失未备份记录。不同协议、主机与端口属于不同浏览器存储来源。

## 算法与坐标契约

`src/core/types.ts` 定义预处理、质量评估、面部关键点、头发分割、配准、比较和 AI 接口；`src/core/providers.ts` 保留 Apple Vision 同契约适配边界。首版不依赖原生框架。

浏览器默认 CPU、单 Worker 串行运行 MediaPipe Face Landmarker / HairSegmenter。分析最长 45 秒，可明确重试；缺少 Worker、OffscreenCanvas、Worker WebGL2、模型加载失败等情况保留人工锚点与描线。CPU delegate 仍可能需要图形资源进行像素转换。

原始文件字节独立保存。导入时原生解码处理 EXIF 方向/镜像一次，形成统一方向的工作图。所有标注保存为**方向统一后的原图归一化坐标**；乘 `originalWidth/Height` 得到原图像素，乘 `width/height` 得到工作图像素。配准在工作图像素空间求解，当前 → 参考的相似变换另行计算，未把变换写回原始标注。

算法结果保存来源、固定版本、输入/推理尺寸映射和未校准的置信信息。面部检测仅报告是否得到可见锚点，不虚构概率；头发均值属于模型输出分数，不代表理发测量正确率。不同自动算法版本混用时停止可信量化，允许人工检查双方标注。模型锁与 SHA256 在 `public/models/assets.lock.json`，准备脚本拒绝不匹配的字节。更多说明见 [分析模块说明](src/analysis/README.md)。

轮廓偏移为当前开放曲线采样点到参考曲线的最近距离中位数，按参考双眼间距归一化；侧脸缺少双眼时使用鼻尖–下巴距离。正值外轮廓表示向外扩张，刘海/鬓角正值表示向下。投影宽高变化比较校正后曲线的横纵包围范围；参考范围小于 1px 的方向留空。它们不能换算为真实发长、体积或毫米剪发量。

姿态差阈值（转头 15° / 仰俯 12°）、面部配准残差、占框比例、亮度和清晰度属于首版研究启发式。二维校正能消除画面倾斜、位置及比例差，不能恢复转头后遮挡区域、真实透视或不同镜头畸变；镜头、白平衡、阴影等需人工确认，或主动请求 AI 诊断。真实同人多次拍摄的精度仍需样本验证。

## 可选 AI

核心界面无须 AI 服务。完整启动、配置与数据说明见 [backend/README.md](backend/README.md)。仅服务端 `.env` 存放 `OPENAI_API_KEY`，前端只接收可选研究访问令牌。

```bash
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
# 在 backend/.env 中填写服务端密钥和准确的 ALLOWED_ORIGINS
backend/.venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --env-file backend/.env
```

前端默认地址 `/ai-proxy` 由 Vite 转发到本机 `127.0.0.1:8000`，方便手机 HTTPS 访问。LAN 使用时把实际来源（例如 `https://192.168.1.50:5174`，不含路径）加入后端 `ALLOWED_ORIGINS`。静态服务器需自行配置同源反向代理，或在 AI 设置中填 HTTPS 后端地址。

用户同意并主动点击后才发送两张头部裁剪图与已有质量/指标；不发送原始文件、名称或项目备注。AI 不改变轮廓、配准与本地量化，失败时本地工作继续。更改输入会标记旧说明过期。后端不持久保存照片，OpenAI `store:false` 不等于零保留。没有用户 API 密钥时，验证使用模拟响应，不产生调用费用。

## 验证

```bash
npm run test
npx playwright install chromium webkit
npm run test:e2e
backend/.venv/bin/python -m pytest backend/tests -q
```

当前环境的浏览器缓存位于 `.browsers/`，运行浏览器测试时使用：

```bash
PLAYWRIGHT_BROWSERS_PATH=.browsers npm run test:e2e
PLAYWRIGHT_BROWSERS_PATH=.browsers npm run evaluate
```

覆盖同图零差异、已知相似变换、不同尺寸、EXIF 方向与镜像、头发改变不影响配准、手工锚点/轮廓、喜欢切换、项目恢复、PNG 像素图层与完整备注、模型失败重试、AI 失败回退。评估样本及 JSON/CSV 记录见 [evaluation/README.md](evaluation/README.md)。

本次 58 项单元测试、45 项端到端检查、40 项后端测试通过；完整验证记录与界面截图见 [docs/validation.md](docs/validation.md)。

Chrome / 桌面 WebKit / 移动 Safari 模拟环境不等同实际 iPhone。触控 Pointer Events 路径已测试；原生触控捕获、相册/拍照入口、HEIC/HDR、Safari 后台恢复、内存压力与持续保存仍需实体机验证。真实改变转头/仰俯的同人照片、实际跨距离/光照照片队列，以及真实 OpenAI 账户调用均尚未验证。
