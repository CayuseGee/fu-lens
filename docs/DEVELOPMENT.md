# 开发与验证说明

该项目停止维护；本说明供自行 Fork 使用。原生 ESM，零 npm 依赖，不需要前端编译。

## 数据约定

- 内部牌码为 `m1..m9`、`p1..p9`、`s1..s9`、`z1..z7`；字牌依次为东南西北白发中。
- YOLO 类别采用 `1m` 等 rank-first 格式，仅在解码边界转换；实际模型 37 类，赤五归一为普通五。
- 阈值默认 0.35；低置信度下界为 `min(0.25, accept)`。前后端使用同一阈值，API 字段为 `accept_threshold`。
- 识别显示以真实 `pool` 为准，不能从默认雀头重建牌张。七对子/国士自动派生，不添加手动牌型选项。
- 纯正九莲及国士十三面必须使用实际和牌张判定，不从结果牌形猜测双倍。

## 保留的设计取舍

- 无三麻/四麻选项，不计算三麻自摸损；宝牌单一计数器，含里宝与拔北宝牌。
- 点数卡与符数明细之间无注释；字号沿用现有 CSS 体系。
- 不增加「牌库录入」标题；清空牌库按钮保持两行；「拍照」打开拍照/相册选择。
- 六个状态开关保持三行两列：门清/立直、一发/抢杠、海底/岭上。
- 应用名为「符镜 · 立直麻将符数识别」，不接云端 LLM API。

## 前端缓存

修改前端时须同步递增三处 `?v=N`：`index.html` 资源链接、`app.js` 模块导入、`sw.js` CACHE/ASSETS。当前 v23。仅修改文档无需改版本。

## 测试

1.0.1 修复满贯以上本场漏算。`npm run test:honba` 需要下述 CDP 浏览器及本地服务，实际点击本场加减和荣和/自摸、亲家/子家切换，验证普通九莲和纯正九莲的 56 个点数显示场景。规则测试另含 128 组满贯以上结算组合。

先运行 `npm run test`。Windows ZIP 回归需要 PowerShell；非 Windows 会显式跳过对应平台测试。

浏览器 smoke 与 runtime 需要启动服务，并另行启动隔离的 Edge/Chrome 调试实例，例如：

```powershell
npm start
# 在另一终端运行，测试配置目录使用独立临时目录，不要复用日常浏览器资料：
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless=new --remote-debugging-port=9223 --user-data-dir="$env:TEMP\fu-lens-test-browser" --disable-gpu --no-first-run about:blank
# 在另一个终端运行：
npm run test
npm run test:runtime
```

`FU_LENS_NO_SIMD=1` 可验证无 SIMD 运行时；`FU_LENS_ASSET_ROOT` 可指向从 APK 提取的 `assets/public`。测试真实执行桌面 WASM，但不证明手机相机可用或模型在真实照片上的准确率。测试结束关闭自己启动的调试浏览器。

`npm run test:android` 为可选真机测试，需要独立调试 APK、ADB 连接以及转发至 9225 的 WebView CDP。使用前阅读脚本前置条件；它不是默认测试的一部分。正式 APK 不开启远程调试。

## Android 资源

本地文件系统路径使用平台 API；URL 使用 `new URL`；ZIP 和 Android assets 必须使用 `/` 且大小写一致。构建通过 `scripts/android-assets.ps1` 在签名前后直接校验归档条目与数据流哈希，不能以 Windows 解压成功代替。详见 [路径经验](ANDROID_ASSET_PATHS.md)。
