# 籽三 · 手机学习库（App 壳）

这是**界面壳**，不含任何知识库内容、不含密钥。手机装好后，用你自己的**只读令牌**
去读你私有的 `medkb-private` 仓库，内容存在手机上，断网也能看。

## 手机上怎么用

1. 手机浏览器打开 `https://mist1494732214.github.io/ziisan-app/`
2. 浏览器菜单 →「**添加到主屏幕**」（iOS Safari：分享 → 添加到主屏幕）
3. 第一次打开会让你填三项：
   - GitHub 用户名：`mist1494732214`
   - 仓库名：`medkb-private`
   - **只读令牌**：在 GitHub → Settings → Developer settings →
     **Fine-grained tokens** → Generate new token：
     - Repository access：**Only select repositories → medkb-private**
     - Permissions → Repository permissions → **Contents = Read-only**
4. 点「登录并同步」→ 自动校验令牌与离线包 → 进入课程列表
5. 在 App 内点「☁ → 立即同步全部」把 14 门课（约 6 MB）下到手机 → 之后离线可读

## 隐私

- 令牌只存在手机的 `localStorage`，不会上传到任何服务器（内容直接从 `api.github.com` 读）
- 本仓库公开，但只放界面代码；你的笔记、教材摘录都在私有仓库里
- 令牌丢了/泄露：GitHub → Settings → Applications 里撤销即可

## 开发者

界面源码在私有仓库 `ziisan-standalone` 的 `web-mobile/`，由 `mobile-app/publish.py` 同步到这里。
