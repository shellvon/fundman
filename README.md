# Fundman
一个可以直接在命令行查看自己基金更新情况的玩具

# How to use ?

首先, 您需要安装依赖: `npm install` 然后直接 `node app.js <配置文件>` 或者 `npm run dev` 即可

配置文件内容:

```json
[
    {
        "name": "基金名字,可选参数",
        "code": "基金代码,必须且唯一",
        "holdings": "持有份额",
        "cost": "购买时成本"
    }
]
```

# 效果图:

![效果图](./img/example.png)
