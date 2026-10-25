# 星星钱罐

给孩子使用的零花钱与习惯养成应用。iPad 和手机使用同一个家庭账本，数据通过 Render Web Service 和 PostgreSQL 同步。

## 功能

- 记录和修改零花钱，自动生成收支账单
- 中文阅读、英文阅读、按时入睡等每日奖励任务
- 晚睡、摸头发走神等温柔提醒
- 自定义奖惩规则、暂停或修改每日任务
- 孩子名字、头像和攒钱目标
- 愿望清单、价格、进度和愿望实现记录
- 星光等级、连续打卡、动画和音效反馈
- iPad、手机和桌面自适应布局
- `/ipad` 和 `/phone` 两个入口，共用同一份云端数据
- 断网时先保存本机，恢复网络后自动合并同步
- 已配置主屏幕 App 图标、启动名称和独立窗口模式

## 本地使用

不连接数据库时，可以直接打开 `index.html` 或运行 `npm start`，应用会使用本机存储和内存同步。

连接 PostgreSQL：

```bash
DATABASE_URL="postgresql://..." npm start
```

访问：

```text
http://localhost:10000/ipad
http://localhost:10000/phone
```

## 部署

仓库包含 `render.yaml`，用于创建 Node Web Service 和 PostgreSQL 数据库。线上服务必须设置：

- `DATABASE_URL`
- `FAMILY_ID`
- `NODE_ENV=production`

数据库连接成功后会自动创建 `star_piggy_bank_state` 表。当前版本固定为一个家庭、无注册登录；后续商业化时可在现有 `family_id` 基础上增加账号和家庭成员。
