# Android 打包路径经验：文件存在不等于能被读取

## 本次故障

符镜 r3 提示无法读取 `/vendor/ort-1.17.3/ort.wasm.min.js`。实际文件已进入 APK，但 ZIP 原始条目是：

```text
错误：assets/public/vendor\ort-1.17.3\ort.wasm.min.js
正确：assets/public/vendor/ort-1.17.3/ort.wasm.min.js
```

Android `AssetManager.open("public/vendor/ort-1.17.3/ort.wasm.min.js")` 按资源路径查找，不会把 ZIP 条目中的反斜杠自动变成目录分隔符。该手机的原生对照读取已证实：旧路径报 `FileNotFoundException`，同一批资源改为正斜杠后可读，内容 SHA-256 一致。

## 区分三类路径

| 使用位置 | 正确方式 |
| --- | --- |
| Windows 本地文件系统路径 | 使用 `Join-Path`、`Path.Combine`、`node:path` 等平台 API |
| ZIP/APK 条目名、Android assets 路径 | 使用 `/`，大小写精确匹配；不能直接沿用 Windows 相对路径 |
| 浏览器 URL | 使用 `new URL(...)`；不能用 Windows `path.join` 拼 URL |

不要把所有路径一律替换成 `/`。应在“本地文件系统路径转为归档条目名”的边界规范化，并保持资源读取端使用同一约定。

## 字符串转义不是路径规范化

- PowerShell 单引号字符串中，`'\'` 是一个反斜杠。规范化写作 `.Replace('\', '/')`，不需要写两个反斜杠。
- JavaScript/Java 的字符串字面量需要转义反斜杠：`"\\"` 表示一个反斜杠。JavaScript 可用 `.replaceAll('\\', '/')`。
- JSON 显示 `\\` 通常表示编码后的一个反斜杠，需先解析再判断实际字符串；不能按日志外观直接数字符。
- 文件名的大小写是另一个独立问题；Windows 上能打开 `Vendor` 不代表 Android 上可替代 `vendor`。

## 防复发检查

1. 在签名前检查 ZIP 的**原始条目名**，拒绝反斜杠和重复条目。
2. 按大小写敏感规则确认所有预期 `assets/public/...` 路径存在。
3. 直接从归档条目的数据流计算 SHA-256，与源码文件比较。
4. 签名后再执行一次相同检查，并验证签名、对齐和离线权限。
5. 用 Android 原生资源读取或真实 WebView 验证关键 JS、WASM、ONNX；桌面解压验证不能代替这一层。

现有实现：`scripts/android-assets.ps1`；构建脚本在签名前后自动调用。回归测试覆盖正常路径、反斜杠、资源缺失、内容损坏、重复条目、大小写错误，并纳入 `npm run test`。

**关键教训：Windows 解压后文件齐全且哈希一致，只能证明解压出的内容一致，不能证明 ZIP 原始路径被 Android 正确识别。** 不应仅凭通用错误文案判断“WebView 太旧”或“模型不兼容”，应先核对真实资源请求和 APK 原始条目。

## 本轮交付边界

2026-09-10：r4 已修正打包路径，正式包为 `com.fulens.app` / `1.0.0` / `versionCode=4`，复用原签名，关闭调试且无 INTERNET 权限。用户要求自行测试并直接生成 APK，因此本轮未进行手机功能测试；安装成功不等于识别准确率或完整拍照流程已验收。
