# 可复跑的 2D 算法研究评估

启动本地开发服务后，使用真实的 App 图片预处理、MediaPipe CPU Worker、配准、质量检查和轮廓指标模块运行：

```bash
npm run dev
# 另一终端：
node scripts/evaluate.mjs --browser chromium
node scripts/evaluate.mjs --browser webkit
```

默认连接 `http://127.0.0.1:5173`，可通过 `--base-url` 改成另一个本地地址。浏览器二进制优先使用本工程已有的 `.browsers`，否则使用 Playwright 系统缓存；也可设置 `PLAYWRIGHT_BROWSERS_PATH`。脚本校验模型 / WASM 与 `public/models/assets.lock.json` 一致，阻止外部 HTTP 请求；不调用 AI 服务或付费 API。

每个浏览器生成 8 个条件：原始内容的统一 JPEG 基线、8° 画面旋转加平移、0.82 / 0.58 占框缩放、0.80 / 0.10 / 4.00 RGB 光线变换，以及仅覆盖姿态元数据为 yaw=35° 的模拟门槛测试。输入及 App 处理后的 JPEG 分别保存在 `samples/<browser>/`；JSON 和 CSV 保存在 `results/<browser>.{json,csv}`。

JSON 保留生成参数、已知变换、估计变换、锚点 / 轮廓、质量状态、区域指标、模型版本 / 哈希和置信来源。CSV 是可直接导入电子表格的对比摘要。首次推理包含模型初始化，耗时不能视为稳态性能。

## 指标解释与限制

- `rawLandmarkReprojectionRMSEPixels`：根据已知 Canvas 变换投影基线算法锚点后，与当前算法锚点的差异；反映变换条件下的识别稳定性。
- `registrationProbeRMSEPixels`：用已知变换生成当前锚点位置，再通过估计配准变换恢复，检查是否回到基线位置。
- `fittingResidualPixels`：算法用自身检测锚点求解配准后的拟合残差，不能作为独立精度证明。
- `qualityUnconfirmed` 保留真实 App 的未确认状态。`qualityWithSimulatedConfirmation` 人为开启研究确认标志，以观察候选轮廓的稳定性；这不是理发师的实际复核。区域值仅在该状态允许时输出，单位为面部参考尺度百分比。
- `simulated-yaw-35` 的图片没有转头；这是明确标记的元数据门槛测试。其他 Canvas 缩放、旋转、RGB 调整也不模拟真实透视、镜头畸变、遮挡或物理光照。

只有一张公开领域人像，8 个条件不代表 8 个独立样本，也不能证明真实理发轮廓精度。还需要同一人、同一发型的真实角度 / 距离 / 光照采集队列、多种发型和肤色，以及人工参考锚点 / 轮廓。模型置信值尚未校准，不能解释为准确率。

来源及公开领域说明见 [fixture attribution](../tests/fixtures/ATTRIBUTION.md)。派生图片仅用于算法研究和回归验证，不表示人物对本项目的认可。
