# 源码提交与手动部署边界

## Context（上下文）

2026-10-21，用户明确要求完成本地交付后提交，部署由用户手动操作，测试文件及本地杂项不进入提交。

## Fact / Pitfall（事实与边界）

- 本次授权 Git 本地提交，不扩展为远端推送、安装 Docker、真实服务器部署或素材再分发授权。
- `.gitignore` 只能阻止未跟踪文件被误加入，不能隐藏已经受跟踪的测试修改。不得用删除原有测试或 `git rm --cached` 规避。
- 测试、日志、截图、依赖、游戏素材、下载包、账号数据库、秘密和备份不纳入本次提交。原仓库测试仍保留在 Git 历史和源码树中，本地测试修改继续留在工作区。
- `.context/` 和根索引作为必要接手文档提交，不包含秘密正文或账号数据库。
- Git 不携带素材；`shared/asset-release.json`、`tools/deploy/init-assets.py`、初始化镜像和 Compose 负责部署时获取固定发布包，校验后写入持久卷。部署命令见 `docs/COMPOSE.md`。
- 用户进一步指出部署不能缺素材：首次启动的初始化是部署必经步骤，不是让部署者只拿源码空跑；下载失败会阻止应用启动，服务器必须具备该固定发布包的下载条件。
- 全量历史失败不在本次清零范围，已有 CI 测试继续保持，不把本地未提交的新测试当作远端存在的文件。

## Solution / Convention（执行规约）

1. 只暂存运行源码、依赖锁、配置和必要文档，显式排除 `test/`、新增测试脚本和开发页面；不使用无筛选的 `git add .`。
2. 提交前检查暂存文件清单、空白错误和敏感路径；新增 Compose CI 不得引用未提交测试。
3. 容器镜像保留 `LICENSE`、`NOTICE.md` 和 `THIRD-PARTY-NOTICES.md`，不把代码许可扩展到游戏素材。
4. 部署由用户执行；无 Docker、真实十六人完整对局、服务端接管整机预算与完成时限、目标机器负载和流量测量仍必须如实注明。

## Reference（溯源）

- 用户本次直接授权：做完提交，由用户手动部署，不提交测试等本地产物。
- `.gitignore`、`.dockerignore`、`Dockerfile`、`.github/workflows/ci.yml`、`docs/COMPOSE.md`。
- `.context/architecture/project-handover.md` 与 `.context/pitfalls/loadout-deck-selector.md`。
