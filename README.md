# 符镜 / Fu Lens

日本立直麻将拍照识别、符数、番数与点数计算工具。提供原生 JavaScript PWA 和 Android 离线 APK，中文界面，无云端 LLM API，无 npm 依赖。

> **这是个人兴趣项目，现按现状公开，不再进行更新、改进或维护，也不承诺处理 Issue 或合并 PR。欢迎自行 Fork、修改及另行发布。原项目代码采用 MIT 许可，允许商业使用；分发时须保留版权和许可声明。第三方模型与运行时的许可另见下文。软件不提供任何担保。**

## 100% AI 开发声明

**这是一个 100% 由 AI 编写的个人兴趣项目，不是作者手工编程完成的作品。** 本项目自身的应用代码、界面实现、修复与文档由 AI（包括 Codex、DeepSeek）生成和修改；作者负责提出需求、选择方案、实际使用测试与反馈，并组织发布。

这里的「100% AI」指本项目自身的开发方式，不代表内置的第三方模型、ONNX Runtime 或其他上游组件由本项目的 AI 创作；它们的来源、版权与许可仍归原作者，见 [第三方声明](THIRD_PARTY_NOTICES.md)。AI 参与开发也不意味着运行时调用云端 AI：应用识别仍在本地执行，无云端 LLM API。

AI 生成代码可能存在遗漏或错误，测试通过不等于规则完整、识别准确或适用于所有设备。请自行核验结果。本项目仍按 MIT 和现状提供，不再维护或改进。

## 能做什么

- 拍照或相册选图，裁剪牌面，使用本地 YOLO nano 模型识别麻将牌，显示检测框和置信度，支持人工校对和手动录入。
- 在「01 牌面」展开「本地模型识别阈值调整」：默认 0.35，范围 0.10–0.90，步长 0.01，支持恢复默认并在本机保存。
- 自动拆分面子与雀头，支持切换拆分方案，设置明暗刻、杠、和牌张、场风、自风、荣和与自摸。
- 计算符数与明细，包括门清荣和、听牌形、雀头、明暗刻杠加符，七对子固定 25 符、平和自摸 20 符等。
- 计算常见役种、番数、荣和与自摸点数及本场；支持役满复合、多倍役满和累计役满。
- 判定七对子、国士无双与十三面、九莲宝灯与纯正九莲宝灯；双倍判定需要正确指定和牌张。
- 立直、一发、抢杠、海底、岭上等状态自动联动，宝牌数量手动输入。
- Android 内置模型与 WASM 运行时，无 INTERNET 权限；PWA 在首次成功缓存资源后可离线使用。

## 使用限制

识别结果需要人工复核，不能从一张照片可靠推断所有对局条件。光线、遮挡、牌背、字体和拍摄角度可能影响准确率。本项目不是官方裁判工具，也不保证覆盖所有地方规则。

模型为 37 类，赤五会归一为普通五，宝牌（含里宝与拔北宝牌）须自行计数。界面没有三麻/四麻切换，不计算三麻自摸损。当前没有任意自定义加符的界面；门清荣和等由规则与手牌状态计算。

Android 不调用 Python/Ollama 后端，也不需要电脑在线。网页端本地推理失败时可尝试运行在自己电脑上的 Python YOLO 或本地 Ollama；未配置这些可选组件时仍可手动录入。浏览器缓存可能被系统清理；手机通过局域网使用相机/PWA 通常需要 HTTPS。

## 本地运行

需要 Node.js 20 或更新版本。无需 `npm install`。

```sh
git clone https://github.com/CayuseGee/fu-lens.git
cd fu-lens
npm start
```

打开 <http://localhost:4173>。模型和运行时已随源码提供，无需云端密钥。配置参考 [.env.example](.env.example)；服务仅应运行在可信本机或局域网，不是经过安全加固的公网服务。

可选 Python 回退依赖：`pip install numpy onnxruntime pillow`。Ollama 是另一项可选本地服务，不随本项目附带。

## Android 构建

当前版本为 **1.0.2 / versionCode 7**，前端缓存版本 v24，最低 Android 8.0。安装包见 [Releases](https://github.com/CayuseGee/fu-lens/releases)。

1.0.2 修复两杯口与七对子牌形冲突、七对子复合役和全带幺九判定。一杯口、两杯口仅门清成立，二者不重复计番；两杯口不与七对子复合，但可与清一色、纯全带幺九或混全带幺九复合。七对子可与清一色、混一色、断幺九、混老头及适用状态役复合，仍固定 25 符。

Windows 构建需要 PowerShell、JDK 21、Android SDK Platform 36 和 Build Tools 36.0.0：

```powershell
./scripts/build-apk.ps1 -SdkDirectory 'C:\Android\Sdk' -JavaDirectory 'C:\Program Files\Java\jdk-21'
```

输出位于 `artifacts/`。脚本会创建本地签名资料；**不要公开 `.android-signing/`、私钥或密码**。自行构建的签名与原作者不同，不能直接覆盖原作者签名的已安装应用。使用 `-DebugBuild` 可生成独立调试包 `com.fulens.app.debug`；正式包为 `com.fulens.app`。

## 验证与开发

```sh
npm run test
npm run test:runtime
```

基础套件当前报告 58 项通过。注意：没有 CDP 9223 浏览器时，`smoke.mjs` 会打印 SKIP 并退出成功，不能据此声称浏览器测试已执行。`test:runtime` 需要真实浏览器和本地服务，用于 WASM 推理及页面回归；不是手机验收。`test:yaku-ui` 实际录入 11 组复合役牌形并切换门清状态。`test:android` 需要调试 APK、ADB 和 WebView CDP，参见 [开发说明](docs/DEVELOPMENT.md)。最新手机拍照、识别准确率及完整离线流程由使用者自行测试，不承诺设备兼容性。

## 目录

| 路径 | 内容 |
| --- | --- |
| `public/app.js` | 页面与状态交互 |
| `public/fu.js` / `public/yaku.js` | 拆牌、符数、役种与点数 |
| `public/yolo.js` | 本地 ONNX 推理与检测解码 |
| `public/models/` / `public/vendor/` | 浏览器及 APK 内置模型、运行时 |
| `models/nano/` | 可选 Python 后端模型副本 |
| `android/` / `scripts/` | 原生 WebView 外壳及构建、资源检查 |
| `test/` | 规则、模型接口、ZIP 路径、浏览器回归 |

## 历史与许可

历次已知变更见 [CHANGELOG.md](CHANGELOG.md)，Windows 正反斜杠导致 Android 资源不可读的经验见 [ANDROID_ASSET_PATHS.md](docs/ANDROID_ASSET_PATHS.md)。这是整理后的源码快照，不伪造未保留的历史提交。

原创代码：[MIT License](LICENSE)，Copyright (c) 2026 CayuseGee。你可以复制、修改、再发布、再许可和商业使用，不需要另行征得作者同意，但必须保留 MIT 要求的声明。请勿暗示衍生版本由原作者维护或背书。

模型来自 [nikmomo/Mahjong-YOLO](https://github.com/nikmomo/Mahjong-YOLO)，运行时来自 [Microsoft ONNX Runtime](https://github.com/microsoft/onnxruntime)。它们保留原有许可与版权；详情见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。上游训练工具、训练数据及其他独立材料不因本项目的 MIT 声明而自动获得重新授权。
