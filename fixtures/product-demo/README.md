# 当前产品的虚构演示材料

由仓库 `npm run demo -- --python <trusted-python-3.11+>` 复制到独立样例 Project，再调用现有 CLI 形成 Work、Verified Save 和三类 Board 块。

输入为两份 UTF-8 CSV：`id=2` 的记录相同。显式对齐三列、合并、按 id 去重并排序后，应得到 id 1/2/3、地区北/南/北、金额 100/80/20，总计 200。

`--serve` 在空闲 loopback 端口启动当前 HTML UI，不自动打开浏览器；Ctrl+C 关闭后样例保留。材料在 `test/.tmp`，开发状态在 `.atlas/demo`。每次运行创建新目录，不清理旧演示、修改正式安装或扫描用户资料。

这只是可复现的虚构产品演示，不证明真实资料库验收、真人语义判断、原生 Desktop 或不同产品 Host 接续。

独立待入 TXT 是原生 Desktop Import 的可选样例；仅 HTML 演示没有本地文件选择器，不能执行这个选取步骤。

关闭后，用终端输出中的 `demo_id` 执行 `npm run demo -- --python <trusted-python-3.11+> --resume <demo-id> --serve`，重新打开同一份 Work、Save 和 Board，不复制成果。仅接受本仓库生成的 UUID，状态或路径不符时停止；中断在准备阶段的样例仍需按已保存记录诊断，不自动称已恢复。
