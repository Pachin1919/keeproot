# Local Module 开发示例（V2.0 源码候选）

`uppercase-prefix.json` 是一个单文件 `text_transform_v1` 示例。它把已登记的 TXT 内容转成大写，并加上 `REVIEWED:` 前缀。预览包不会执行代码；安装后默认停用。启用和处理会以 Atlas 进程的账号权限执行包内 JavaScript，当前没有代码沙箱。只安装你已审阅并信任的本地包。

以下命令在仓库根目录运行，并须先把 `ATLAS_STATE_DIR` 指向仓库 `test/.tmp/` 下的**隔离状态绝对路径**；不要指向正式安装状态。`--json` 返回的 `data` 包含下一步要用的 Hash、revision 和 Save ID。

```powershell
node bin/atlas.js module package-preview --file fixtures/local-module/uppercase-prefix.json --json
node bin/atlas.js module install --file fixtures/local-module/uppercase-prefix.json --expected-sha256 <预览的sha256> --expected-revision <预览的revision> --request-key <本次安装唯一键> --json
node bin/atlas.js module enable local.example-uppercase-prefix --expected-revision <安装后的revision> --request-key <本次启用唯一键> --json
node bin/atlas.js module preview local.example-uppercase-prefix --project <Project_ID> --resource <已登记TXT_Resource_ID> --json
node bin/atlas.js module save local.example-uppercase-prefix --project <Project_ID> --resource <已登记TXT_Resource_ID> --target <Root内新目标相对路径> --request-key <本次保存唯一键> --tool <Host名称> --client-run-id <Host运行ID> --json
node bin/atlas.js save review <上一步save_id> --json
node bin/atlas.js save execute <save_id> --expected-preview-revision <审阅的preview_revision> --reason <确认理由> --json
node bin/atlas.js module disable local.example-uppercase-prefix --expected-revision <当前revision> --request-key <本次停用唯一键> --json
```

Save 只接受已登记、位于同一 Project 的未变更 TXT 来源和一个不存在的新目标；仍须单独审阅并确认执行。停用后新处理拒绝，已保存结果仍可按 Save ID 读取。示例不是对任意包的安全认证，也不代表 V2.0 已公开发布。
