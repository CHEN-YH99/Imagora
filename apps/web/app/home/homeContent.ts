export const galleryItems = [
  {
    title: "霓虹雨巷",
    style: "电影写实",
    prompt: "雨夜赛博巷道，霓虹反射，35mm 电影镜头",
    cost: 16,
    artClass: "art-cinematic"
  },
  {
    title: "陶瓷质感耳机",
    style: "产品摄影",
    prompt: "白瓷无线耳机，薄荷色光带，干净棚拍",
    cost: 14,
    artClass: "art-product"
  },
  {
    title: "太阳能信使",
    style: "动漫插画",
    prompt: "未来城市信使，明亮发光披风，动画封面",
    cost: 12,
    artClass: "art-anime"
  },
  {
    title: "音乐节主视觉",
    style: "海报设计",
    prompt: "音乐节主视觉，撞色几何，留出标题版位",
    cost: 18,
    artClass: "art-poster"
  },
  {
    title: "海岸创作室",
    style: "空间概念",
    prompt: "海边创作工作室，玻璃立面，晨光进入空间",
    cost: 16,
    artClass: "art-architecture"
  },
  {
    title: "创作流程图",
    style: "等距图形",
    prompt: "智能创作流程等距插图，节点清晰，活力配色",
    cost: 10,
    artClass: "art-isometric"
  }
];

export const promptExamples = [
  "半透明智能相机置于黑曜石湿润台面，薄荷色轮廓光，高细节产品摄影",
  "地下电子音乐节活动海报，预留橙色标题空间，几何图形鲜明有冲击力",
  "等距视角创作者工作台，包含图片网格、积分账本和队列状态，深色专业界面",
  "面向海岸的未来创作室，玻璃墙、模块化家具，清晨自然光进入室内",
  "动漫风角色正在设计全息服装，姿态有张力，高饱和高光，封面构图"
];

export const pricingPlans = [
  {
    name: "入门版",
    price: "9 元",
    credits: "220 积分",
    note: "适合灵感探索",
    highlight: false,
    features: ["约 27 张标准写实图", "生成历史保留 30 天", "标准下载与收藏管理"]
  },
  {
    name: "创作者版",
    price: "19 元",
    credits: "620 积分",
    note: "多数创作者的起点",
    highlight: true,
    features: ["约 77 张标准写实图", "高清下载", "失败任务自动退还积分"]
  },
  {
    name: "团队版",
    price: "49 元",
    credits: "1,850 积分",
    note: "适合小团队和电商运营",
    highlight: false,
    features: ["并发生成队列", "商用素材工作流", "优先任务处理"]
  }
];
