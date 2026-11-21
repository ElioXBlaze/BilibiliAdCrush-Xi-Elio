# BilibiliAdCrush Xi/Elio

全站精准去广告的哔哩哔哩用户脚本：不只是把推广卡藏起来，而是**原位换成一条真实推荐视频**——不留空白容器、不打乱栅格、不重排列表。专为 iPad / iPhone Safari + **Stay** 设计，零外部依赖、零数据上报。

> 当前版本：**2.0.0**　作者：Xi/Elio X. Blaze

---

## 为什么不是简单的 `display:none`

把广告卡直接隐藏，是这类脚本最常见的做法，也是最容易露馅的做法：

- 隐藏后留下一个空槽，栅格出现怪异留白；
- B 站自己用 `:nth-of-type` 算边距，删掉节点会让后面的卡片集体错位；
- 「小火箭」在 DOM 上和普通视频卡几乎完全一致（同为 `.bili-video-card.is-rcmd.enable-no-interest`），靠类名根本分不出来。

所以这个脚本换了个思路：**认出广告 → 用一条真实视频把它的位置占住**。原位、DOM 序号不变、grid 不重排、没有空白容器，肉眼看到的就是一条正常的推荐。

## 广告怎么认出来

三层判据，逐层收紧，宁可漏杀不误杀：

1. **接口黑名单（主判据）**：推荐流返回的 `business_info.is_ad_loc === true`；
2. **广告角标**：卡片自带的推广标记；
3. **广告跳转包装**：`a[href*="cm.bilibili.com"]` 与 `[data-target-url]` 必须同时存在（只满足一个不判）；
4. 补充判据：天马 / sycp 商业素材、主链接指向商业域或空链接；
5. 安全闸：结果必须「像一张卡片」，并排除番剧、直播等正常内容卡——避免在视频页等布局下误藏整块容器。

## 补位数据从哪来

按可靠性排序，前一级失败自动降级：

1. **hook 页面自身的推荐请求响应**（最稳，本来就是页面要的数据）；
2. **重放页面已签名的推荐 URL**——等价于调推荐 API，无需自己算 wbi，风控风险最低；
3. **自算 wbi 签名**主动请求；脚本内置社区公开的 mixin key 重排表，签名失败自动降级；
4. **复用同页真实卡模板 + 真实 item** 做 `replaceWith`（不发新请求）；
5. 最后兜底：整卡移除，让栅格自然重排。

补位池还没到时，先把广告内容隐藏、布局槽保留，等数据到了原位替换——所以不会出现「先空一下再跳出来」。

## 其它细节

- **不改写页面响应体**，只读不改，避免干扰 B 站 Vue 渲染；
- **`@grant none`**：Stay 的 `GM_*` 子集不完整，脚本全部走原生 DOM / `fetch`；
- 首屏对齐、丝滑收缩 / 展开、松手吸附最近边缘的悬浮窗（减号收起、小火苗展开）；
- 低频全扫兜底：覆盖「换一换」、滚动加载、SPA 复用节点等场景；
- 菜单里可以随时 **查看统计**，看这一场拦了多少张、补了多少张。

## 安装

### Stay（iPad / iPhone 推荐）

用 Safari 打开直链，Stay 会接管安装：

```
https://raw.githubusercontent.com/ElioXBlaze/BilibiliAdCrush-Xi-Elio/main/BilibiliAdCrush-Xi-Elio.user.js
```

或手动：Stay → 新建脚本 → 粘贴 `BilibiliAdCrush-Xi-Elio.user.js` 全文 → 保存 → 打开 `bilibili.com` 刷新。

### 其它用户脚本管理器

新建脚本，粘贴全文保存即可。脚本 `@run-at document-start`，需要在页面脚本之前注入。

## 配置与调试

配置写在 `localStorage`，刷新后生效：

```js
// 关闭首屏轮播位处理等开关（按需组合）
localStorage.setItem('__yb_config', JSON.stringify({ hideCarousel: false }))
```

调试输出：

```js
localStorage.setItem('__yb_debug', '1')   // 刷新后控制台有详细日志
__YBBiliAd.report()                        // 打印当前统计与补位状态
```

关掉调试：`localStorage.removeItem('__yb_debug')`。

## 兼容范围

`@match` 覆盖：`www.bilibili.com`、`search.bilibili.com`、`t.bilibili.com`、`live.bilibili.com`、`space.bilibili.com`、`m.bilibili.com`。

已知限制：

- 桌面浏览器适配未做验证，主要针对 iPad / iPhone Safari + Stay；
- B 站推荐接口或 wbi 常量更新时，签名路径会自动降级到「重放页面签名」或「复用同页卡片」；
- 脚本只处理**页面推荐流里的推广位**，不拦截播放器贴片与直播礼物类商业化模块。

## 免责声明

本项目为个人自用的广告屏蔽与体验优化脚本，与哔哩哔哩官方无关。它不破解、不绕过付费内容、不上报任何数据。使用风险自负，请遵守平台条款。

## 许可

MIT License，见 [LICENSE](LICENSE)。
