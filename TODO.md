# TODO / Roadmap

当前版本：`1.4.3` · 目标 DSH：`0.2.1-rc.5` · 测试：338 个单测 + CI（Node 22/24、pack）

图例：`P0` 阻塞主流程 · `P1` 重要 · `P2` 体验/工程 · `—` 待定

---

## P0 · Windows 远端支持

**状态：未开始。阻塞项：需要一台可达的 Windows 主机做真机验证。**
当前 `233_5090_Win_Direct`（`192.168.1.111`）从现有网络 `No route to host`，无法验证。

Windows 不是加一个开关：现有实现默认 POSIX（`cd && cmd`、`grep`/`find`、`/` 路径）。
需要一层平台适配，按以下顺序做，每步都要真机验证：

- [ ] **平台探测**：连接后探测一次（`cmd /c ver`，失败回退 `uname -s`），结果缓存在连接上
- [ ] **路径层**：`C:\x` ↔ `C:/x` 规范化；绝对路径判定、`join`/`relative`；放宽占位目录解码（当前要求以 `/` 开头）
- [ ] **命令层**：按平台生成 cwd 前缀与引号（`cmd /d /c` 或 `powershell -NoProfile -Command`）
- [ ] **bash 工具**：Windows 上明确走 PowerShell，并在工具描述里说明语义差异
- [ ] **搜索工具**：`glob` → `Get-ChildItem -Recurse -File`；`grep` → `Select-String`；输出解析、结果上限、超时
- [ ] **SFTP 文件工具**：`read`/`write`/`edit`/`read_image` 的路径转换
- [ ] **终端**：远端 cwd 命令与默认 shell（cmd / PowerShell）适配
- [ ] **上传**：远端目录路径转换与重名策略
- [ ] **测试**：路径/解析单测 + 真机 smoke（`192.168.1.111` 开启 OpenSSH Server 后）
- [ ] **文档**：兼容性矩阵与已知差异（如 `grep` 的 ignore 规则）

**验收标准**：在 Windows 远端上，`bash`/`read`/`write`/`edit`/`read_image`/`glob`/`grep`
七个工具 + Files 侧栏 + Terminal + 上传全部可用，本地工作区无回归。

---

## P1 · 安全与可靠性

- [ ] **口令迁移到 DSH credentials**：不再明文写 `dsh_ssh_hosts.json`；提供旧数据迁移与回滚
- [ ] **ProxyCommand 显式确认**：设置页标注“会在本机执行命令”，首次执行前二次确认
- [ ] **Known hosts 管理**：查看 / 删除 / 重新信任，替代手动删文件
- [ ] **断线状态与重连**：工具错误区分网络/认证/主机密钥（侧栏在线圆点已完成，重连策略仍缺）
- [ ] **连接测试展示完整链路**：`jump1 → jump2 → target`、耗时、认证方式、服务器 banner
- [ ] **多跳凭据**：终端跳板链改为生成临时 `ssh_config`（`ssh -F`），使用插件里存的密钥/端口，而不是依赖系统配置

## P1 · 文件与传输

- [ ] **流式上传**：SFTP write stream + 本地临时文件，去掉 256 MiB 内存缓冲
- [ ] **远端下载**：Files 面板下载文件到本地（保存对话框）
- [ ] **传输进度与取消**：上传/下载进度条，可中止
- [ ] **拖拽上传**：拖文件到 Files 当前目录即上传
- [ ] **批量传输**：目录上传/下载
- [ ] **Files 头部远端路径**：显示 `host:/remote/path`（自绘面板或等上游提供 seam）

## P2 · 体验

- [ ] 导入选择器：勾选要导入的主机、显示 jump 映射、已存在去重
- [ ] 高级字段折叠：`knownHostsPath`、连接超时、keepalive
- [ ] 空状态与错误文案统一（网络/认证/权限/不存在）
- [ ] 中英文案完整性检查（未使用 key 清理、缺 key 告警）

## P2 · 性能

- [ ] Files 轮询自适应：面板可见 3s、隐藏暂停、慢链路退避
- [ ] 目录 stat 缓存与变更合并，减少 round trip
- [x] 连接池容量：满时驱逐空闲连接并带超时（不再无限等待）；跳板连接不被驱逐
- [ ] 图片/PDF 分块流式预览（当前受 32 MiB 上限整读）

## P2 · 工程

- [ ] **E2E**：CI 用 Docker 起 `sshd`（含一个 jump 容器），跑 pool / files / upload / terminal smoke
- [ ] **client bundle 构建去重**：`src/hosts/model.js` 与 `client.js` 内联副本改为构建注入
- [ ] **发布流水线**：tag + GitHub Release 已自动化；npm publish 仍未接入（当前只能从 git/本地安装）
- [ ] **兼容性矩阵**：对 0.2.x 若干版本跑安装 + 启动 smoke
- [ ] **错误码表**：`SshError.stage` → 用户可操作提示（文档 + 设置页内联）

---

## 已完成（近期）

- [x] DSH 0.2 迁移：storage domain、Typert strict codec、primitives 图标
- [x] `~/.ssh/config` 导入（`config.d`、`Include`、`Host *` 默认值）
- [x] Files 侧栏 + Terminal 远端化（SFTP / `ssh -tt`）
- [x] 上传写入远端工作区（重名加序号）
- [x] `ProxyJump` 多跳（引用主机、环检测、终端 `ssh -J`）
- [x] `ProxyCommand`（本机 `/bin/sh` 执行，`%h/%p/%r`）
- [x] 连接测试走跳板/代理链路
- [x] 大文件文本预览按页读取（远端 awk 窗口）
- [x] 目录排序与本地一致
- [x] 桌面端无 `SSH_AUTH_SOCK` 时回退默认私钥
- [x] 搜索框双边框修复
- [x] 侧栏远程工作区：在线/离线圆点、服务器图标、主机 tag（标题改为纯项目名，旧标题自动迁移）
- [x] 远程目录选择器：输入筛选、固定宽度、只纵向滚动
- [x] 设置页版本页脚 + GitHub tag 更新检查（6h 缓存，失败静默）
- [x] 桌面端本地目录弹窗改走 Electron IPC（不再经 host 的 osascript）
- [x] 清空跳板机 / ProxyCommand 可保存；测试连接走完整跳板链路
- [x] 全量复查修复：客户端弹窗竞态/焦点/换主机残留状态；池容量挂死；ExecFs 空文件写入；
      job 日志增量读取；Files 监听器泄漏；占位目录清理尊重 DSH_SSH_REMOTE_ROOT 并预加载；
      stderr 上限；已知主机字段控制字符校验

## 已知限制

- 口令明文存储（见 P1 迁移项）
- 终端跳板认证依赖系统 ssh 配置/agent
- 不支持 Windows 远端（见 P0）
- Files 顶部仍显示本地占位路径
- 不支持 `Match` 块的完整语义（导入时跳过）
- 两个 DSH 实例共享同一 `DSH_HOME` 时 storage 可能互相覆盖
