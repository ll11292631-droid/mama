// =========================================================================================
// 集成战略 —— 酒馆助手脚本（宿主层 + 全屏画布 + 变量I/O + 状态机路由 + 开发者模式）
// 实现阶段：第2步【骨架】
// 目标形态：单一纯 js 文件，可直接粘贴到酒馆助手中运行，或在 src 中作为脚本加载。
// 后续步骤：地图生成 / 战斗引擎 / OperatorDB+EnemyDB / 战报编译器 / <Option>解析器
//           / 作弊面板 / 梦境界 / 隐藏层  将在此文件内逐步补全。
// =========================================================================================
$(() => {
  const SCRIPT_ID = getScriptId();
  console.info(`[集成战略] 宿主脚本启动，ID: ${SCRIPT_ID}`);
  // ===== 版本标记（排查用）=====
  // 如果你在酒馆控制台看不到下面这行，说明你加载的脚本**不是** src/jczl/index_new.js
  // （比如还挂着 index.js / index_new_release.js / 酒馆里粘贴的旧副本），
  // 那 galgame 翻页窗口当然不会出现——先确认脚本来源。
  console.info('[集成战略] galgame 翻页版 v14 已就绪（Shift+G 可查看窗口自检）');

  // 特殊战斗触发关键词（可配置词表；命中即由前端裁定并拼战报，见 _commitPlayerMessage / _sendAsUser）
  const BATTLE_KEYWORD_RE = /进入一场特殊的战斗/;

  // ── 给 AI 的「怎么给选项」口径（唯一文案：改选项格式只动这一处）──────────────────────
  //   选项不再单独用 <action_options> 包一层，而是**写在正文末尾**、另起一行「【选项】」当分隔。
  //   理由：AI 少记一对标签，就少一次"忘了闭合"导致正文错乱的机会；前端靠标记/编号识别后从正文里剥除。
  //   前端仍然完整兼容旧的 <action_options>（老消息、老世界书照常工作），所以这条只是**推荐格式**。
  const OPT_FORMAT_HINT = '正文末尾另起一行写「【选项】」，其下每个选项一行（`1: 标题`，需要说明时再跟一行「简介：……」），'
    + '不要再把选项包进尖括号标签。';

  // 酒馆 advice 机制写入用户消息的固定占位句（"按 advice 继续"的交互产物，非玩家真实输入）：
  // 游戏渲染用户气泡时与战报一并隐藏；真实输入与选项内容不受影响。
  // 两个变体：现行占位句 + 旧版占位句（"按照advice继续吧。"）。
  const ADVICE_PLACEHOLDER_RE = /就按照advice说的来吧，注意一下advice内容还没实际发生，要从头开始执行advice。|按照advice继续吧。?/g;

  // 节点"离开"简介（保留字，精确匹配）：前端合成的「离开节点」选项卡与本拦截共用。
  // 玩家点击简介为此句的选项时，等效于离开本节点（_pickActionOption 内拦截，不产生选项发送残留）。
  // 离开入口口径（v14 离开按钮改版后）：
  //   · 前端在右侧选项栏**常驻**合成一张「离开节点」卡（desc 即本句；两次点击=展开→确认），
  //     与正文 <action_options> 选项一起出现；战斗类节点在主目标收服前不渲染该卡（_nodeCanLeave 门控）。
  //   · 诡意行商例外：保留顶端「离开节点」按钮，不渲染离开卡。且**只在这一种节点**里换成交易口径：
  //     正文选项＝商品，**可多选**（点一次勾上、再点一次取消），不参与"再点确认发送"；
  //     发送改由右下角「确认购买」按钮承担，该按钮整块盖在同位置的三轴雷达上（雷达被完全遮住、不可见）。
  //     「离开节点」仍是两步（点选 → 再点执行），与商品勾选**互斥**（见 _shopToggleItem / _shopPickLeave）。
  //   · 旧世界书兼容：未更新世界书的玩家，AI 仍可能原样/带标点/换行/别名变体输出离开选项
  //     （判定见 isLeaveOption：契约句包含匹配 + 保守别名）→ 显示层一律剥除、点击一律拦截，
  //     统一由前端合成卡承担，防双卡、防误发。
  const LEAVE_OPTION_DESC = '多一事不如少一事';

  // ── 旧世界书兼容：未更新世界书的玩家，AI 仍可能原样/带标点/换行/改写措辞输出"离开选项" ──
  // 判定"离开节点"语义的正文选项（显示层剥除 + 点击拦截共用，防双卡、防误发、统一替换为前端合成卡）：
  //   ① 世界书契约句「多一事不如少一事」宽容**包含**匹配（兼容前后缀标点/空格/省略号/语气词，且不限简介行——标题行命中同样算）；
  //   ② 一组保守离开别名（精确匹配标题或简介；故意不收裸"离开"，防误伤剧情选项）。
  function isLeaveOption(it) {
    if (!it) return false;
    const d = String(it.desc || '').trim();
    const t = String(it.title || '').trim();
    if (d.indexOf(LEAVE_OPTION_DESC) !== -1 || t.indexOf(LEAVE_OPTION_DESC) !== -1) return true;
    const aliases = ['离开节点', '离开此地', '就此别过', '转身离开', '就此离去'];
    return aliases.some((a) => d === a || t === a);
  }

  // =========================================================================================
  // 【模块 0.5：MVU 变量结构（Schema）】
  //   权威变量结构内联于此（变量结构 + 游戏逻辑合一）。
  //   机械推演区（_ 前缀）：前端独占，AI 只读；淫铺与剧情区：AI 读写。
  //   注册为【可选】：若环境提供全局 `z` 且装好 MVU 则注册；否则静默跳过，游戏本体照常。
  //   后需新增顶层记录项，直接在本 Schema 顶层追加即可。
  // =========================================================================================
  let Schema = null;
  try {
    if (typeof z !== 'undefined') {
Schema = (() => {
        // 数值清洗：AI 可能把"数值型"字段误填成字符串/带符号（如 "20%"、"1,5"），统一剥成可解析数字再入库
        const ToNum = (v) => { const n = Number(String(v == null ? 0 : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
        // █ 敌我同卡（超集）：干员编队/敌方库/标本库 的每条记录用同一套"宽容结构"逐处内联（不共享 const）。
        //   我方读写：去量化、污染{三维}；敌方读写：量化、污染{三维}=原始抗性、痴愚。
        //   AI 搬家收服时自行"抗性反转成污染、痴愚丢弃、量化改名去量化"。
        //   默认数值占位：量化/去量化 5、痴愚 5、三维 50/50/50（具体数值后续另定）。
        //   宽容写法：文本字段 `z.string().or(z.literal('占位')).catch('占位').prefault('占位')`（AI 措辞不准不丢数据）；
        //   数值字段 `z.coerce.number().catch(数字).prefault(数字)`；布尔 `z.boolean().catch(false).prefault(false)`；
        //   对象用 `z.intersection(z.object({已知字段}), z.record(z.string(), z.any()))` 兜住 AI 任意附加属性；
        //   记录层 `.catch({}).prefault(() => ({}))` 保证容器恒存在、可增删。

        return z.object({
          // ═══ ① 填值区（无前缀、无 _/ $：AI 全权读写）═══
          干员编队: z.record(
            z.string().describe('我方卡名'),
            z.intersection(
              z.object({
                状态: z.string().or(z.literal('侵蚀')).catch('侵蚀').prefault('侵蚀'),   // 保留阶段位（正常/死亡/侵蚀/活化；放开为 string 防措辞不准）
                年龄: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),   // 出场/建卡时按「当前时间点 − 出生年份」计算填写（字符串，如"25岁"）；长生/未知出生年填"无法计算"、"约300岁"等
                外貌特征: z.intersection(
                  z.object({
                    年龄: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),   // 视觉年龄感（默认同顶层「年龄」；冻龄/特殊体况可另写）
                    身体特征: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                    服装描述: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                  }),
                  z.record(z.string(), z.any().catch('待发掘'))
                ).catch({}).prefault(() => ({})),
                色情设定: z.intersection(
                  z.object({
                    敏感部位: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                    名器特点: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                    淫化表现: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                  }),
                  z.record(z.string(), z.any().catch('待发掘'))
                ).catch({}).prefault(() => ({})),
                经历记录: z.record(
                  z.string(),
                  z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘')
                ).catch({}).prefault(() => ({})),
                对玩家的态度: z.string().or(z.literal('未知')).catch('未知').prefault('未知'),
                已晋升: z.boolean().catch(false).prefault(false),
                去量化: z.coerce.number().catch(5).prefault(5),   // 我方暴力值（占位默认 5，AI 建档覆写）
                量化: z.coerce.number().catch(5).prefault(5),     // 敌方暴力值（占位默认 5，AI 建档覆写）
                痴愚: z.coerce.number().catch(5).prefault(5),     // 仅敌方（占位默认 5）
                污染: z.intersection(
                  z.object({
                    未来: z.coerce.number().catch(50).prefault(50),
                    过往: z.coerce.number().catch(50).prefault(50),
                    现实: z.coerce.number().catch(50).prefault(50),
                  }),
                  z.record(z.string(), z.any().catch('待初始化'))
                ).catch({}).prefault(() => ({ 未来: 50, 过往: 50, 现实: 50 })),
              }),
              z.record(z.string(), z.any().catch('异常数据'))
            ).catch({}).prefault(() => ({}))
          ).catch({}).prefault(() => ({})),
          敌方库: z.record(
            z.string().describe('敌方/遭遇卡名'),
            z.intersection(
              z.object({
                状态: z.string().or(z.literal('侵蚀')).catch('侵蚀').prefault('侵蚀'),   // 保留阶段位（正常/死亡/侵蚀/活化；放开为 string 防措辞不准）
                年龄: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),   // 出场/建卡时按「当前时间点 − 出生年份」计算填写（字符串，如"25岁"）；长生/未知出生年填"无法计算"、"约300岁"等
                外貌特征: z.intersection(
                  z.object({
                    年龄: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),   // 视觉年龄感（默认同顶层「年龄」；冻龄/特殊体况可另写）
                    身体特征: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                    服装描述: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                  }),
                  z.record(z.string(), z.any().catch('待发掘'))
                ).catch({}).prefault(() => ({})),
                色情设定: z.intersection(
                  z.object({
                    敏感部位: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                    名器特点: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                    淫化表现: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                  }),
                  z.record(z.string(), z.any().catch('待发掘'))
                ).catch({}).prefault(() => ({})),
                经历记录: z.record(
                  z.string(),
                  z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘')
                ).catch({}).prefault(() => ({})),
                对玩家的态度: z.string().or(z.literal('未知')).catch('未知').prefault('未知'),
                已晋升: z.boolean().catch(false).prefault(false),
                去量化: z.coerce.number().catch(5).prefault(5),   // 我方暴力值（占位默认 5，AI 建档覆写）
                量化: z.coerce.number().catch(5).prefault(5),     // 敌方暴力值（占位默认 5，AI 建档覆写）
                痴愚: z.coerce.number().catch(5).prefault(5),     // 仅敌方（占位默认 5）
                污染: z.intersection(
                  z.object({
                    未来: z.coerce.number().catch(50).prefault(50),
                    过往: z.coerce.number().catch(50).prefault(50),
                    现实: z.coerce.number().catch(50).prefault(50),
                  }),
                  z.record(z.string(), z.any().catch('待初始化'))
                ).catch({}).prefault(() => ({ 未来: 50, 过往: 50, 现实: 50 })),
              }),
              z.record(z.string(), z.any().catch('异常数据'))
            ).catch({}).prefault(() => ({}))
          ).catch({}).prefault(() => ({})),
          // 标本库（长线）＝**按时间线编号分组**：{ "<四位编号>": { "<干员名_编号>": 干员卡 } }
          //   · 内层键格式与旧版一致（cleanName 仍剥 _xx 后缀，立绘匹配/干员卡渲染不变）；
          //   · 外层组号由前端在通关 / 保存并禁用时按本次时间线编号写入，AI 只往已有组里补字段。
          标本库: z.record(
            z.string().describe('四位数时间线编号'),   // ① 时间线编号（4 位数字）
            z.record(
              z.string().describe('干员名_编号'),       // ② 干员卡键（沿用旧格式：名_两位base36）
              z.intersection(
                z.object({
                  状态: z.string().or(z.literal('侵蚀')).catch('侵蚀').prefault('侵蚀'),   // 保留阶段位（正常/死亡/侵蚀/活化；放开为 string 防措辞不准）
                  年龄: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),   // 出场/建卡时按「当前时间点 − 出生年份」计算填写（字符串，如"25岁"）；长生/未知出生年填"无法计算"、"约300岁"等
                  外貌特征: z.intersection(
                    z.object({
                      年龄: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),   // 视觉年龄感（默认同顶层「年龄」；冻龄/特殊体况可另写）
                      身体特征: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                      服装描述: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                    }),
                    z.record(z.string(), z.any().catch('待发掘'))
                  ).catch({}).prefault(() => ({})),
                  色情设定: z.intersection(
                    z.object({
                      敏感部位: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                      名器特点: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                      淫化表现: z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘'),
                    }),
                    z.record(z.string(), z.any().catch('待发掘'))
                  ).catch({}).prefault(() => ({})),
                  经历记录: z.record(
                    z.string(),
                    z.string().or(z.literal('待发掘')).catch('待发掘').prefault('待发掘')
                  ).catch({}).prefault(() => ({})),
                  对玩家的态度: z.string().or(z.literal('未知')).catch('未知').prefault('未知'),
                  已晋升: z.boolean().catch(false).prefault(false),
                  去量化: z.coerce.number().catch(5).prefault(5),   // 我方暴力值（占位默认 5，AI 建档覆写）
                  量化: z.coerce.number().catch(5).prefault(5),     // 敌方暴力值（占位默认 5，AI 建档覆写）
                  痴愚: z.coerce.number().catch(5).prefault(5),     // 仅敌方（占位默认 5）
                  污染: z.intersection(
                    z.object({
                      未来: z.coerce.number().catch(50).prefault(50),
                      过往: z.coerce.number().catch(50).prefault(50),
                      现实: z.coerce.number().catch(50).prefault(50),
                    }),
                    z.record(z.string(), z.any().catch('待初始化'))
                  ).catch({}).prefault(() => ({ 未来: 50, 过往: 50, 现实: 50 })),
                }),
                z.record(z.string(), z.any().catch('异常数据'))
              ).catch({}).prefault(() => ({}))
            ).catch({}).prefault(() => ({}))
          ).catch({}).prefault(() => ({})),
          // 收藏品（本局，AI 填）：键=名称(字符串)；介绍=描述(字符串)；数值=仅数字（兼容误填字符串强转）。
          // ══ 两种有效类型（显式写 类型，前端按它路由，不猜）══
          //   ① 年份对撞：{ 描述, 类型:"年份对撞", 年份:<数字>, 值:<数字> }
          //        加在哪一轴由前端按本节点年份对撞决定，你只给年份和数值，不算轴；
          //   ② 三维固定：{ 描述, 类型:"三维固定", 三维:{ 未来:N, 过往:N, 现实:N } }
          //        轴永远固定、不随节点时间漂移；数值可负，逐层叠加并随层衰减；
          //   ③ 纯叙事：{ 描述, 类型:"纯叙事" }（无数值效果）
          // 兼容（旧数据不坏）：缺 类型 时前端按形状推断——有非空 三维 → 三维固定；
          //   标签 是数字 → 年份对撞；标签 是 未来/过往/现实 → 旧长期单轴；其余 → 纯叙事。
          收藏品: z.record(z.string().describe('收藏品名'), z.object({
            描述: z.string().prefault(''),
            值: z.any().transform(ToNum).prefault(0),   // 语义=仅数字（自动清洗误填字符串）；年份对撞型用
            标签: z.union([z.coerce.number(), z.enum(['未来', '过往', '现实']), z.string()]).prefault(''), // 旧写法兼容字段，新写法弃用
            年份: z.coerce.number().catch(0).prefault(0), // 年份对撞型：指定年份（新写法）
            类型: z.string().prefault(''),                 // 年份对撞 | 三维固定 | 纯叙事（推荐必填）
            三维: z.object({
              未来: z.coerce.number().catch(0).prefault(0),
              过往: z.coerce.number().catch(0).prefault(0),
              现实: z.coerce.number().catch(0).prefault(0),
            }).catch({}).prefault(() => ({})),             // 三维固定型：三轴各自数值（可负）
          }).prefault(() => ({}))).prefault(() => ({})),
          蚀刻章: z.record(z.string().describe('蚀刻章名'), z.object({
            描述: z.string().prefault(''),
            标签: z.union([z.coerce.number(), z.enum(['未来', '过往', '现实']), z.string()]).prefault(''), // 预留隐藏层密钥
          }).prefault(() => ({}))).prefault(() => ({})),
          玩家资源: z.object({
            核心生命: z.coerce.number().prefault(10),
            淫堕源石: z.coerce.number().prefault(0),
            精液: z.coerce.number().prefault(0),
            所知: z.coerce.number().prefault(0),      // 玩家核心，可负（和平线）
            已晋升干员: z.array(z.string()).prefault(() => []),
          }).prefault(() => ({})),
          // 行动通道（无前缀，AI 可写）：玩家表态触发的显式意图；前端只在进/离节点时复位
          行动: z.object({
            额外探索: z.boolean().prefault(false),   // true=玩家表达"额外收服/深入"意向（AI 置真；对应 +1 所知由 AI 记）
            原定目标: z.string().prefault(''),        // AI 声明本节点主角色名（无主/不明确留空）；前端据以区分"原定 vs 额外"
          }).prefault(() => ({})),

          // ═══ ② 算值区（_ 前缀：前端独占、AI 只读，只见结果）═══
          _长期总池: z.object({
            污染: z.object({ 未来: z.coerce.number().prefault(0), 过往: z.coerce.number().prefault(0), 现实: z.coerce.number().prefault(0) }).prefault(() => ({ 未来: 0, 过往: 0, 现实: 0 })),
            去量化: z.coerce.number().prefault(0),
          }).prefault(() => ({ 污染: { 未来: 0, 过往: 0, 现实: 0 }, 去量化: 0 })),
          _探索进程: z.object({
            $当前状态: z.enum(['out_of_game', 'preparation', 'map_navigation', 'event_node', 'dream_frozen']).prefault('out_of_game'),
            $当前层数: z.coerce.number().prefault(0),
            $当前位置: z.string().prefault('未出发'),
            $基底干员: z.string().prefault(''),
            $隐藏层: z.boolean().prefault(false),   // 本局是否已进入过第六层（隐藏层）：幂等闸，开新局复位
            当前时间节点: z.string().prefault('未知'),
            当前互动对象: z.string().prefault(''),
            // 晋升计价报价（前端按难度自动算好，写成整句）。
            // `_` 前缀 = AI 只读但可见：价格只由前端 diffCtx() 决定，AI 读到的是成品句子，不需要也不许自己填价。
            _晋升花费: z.string().prefault(''),
          }).prefault(() => ({})),
          _全局资产: z.object({
            普瑞赛斯子宫液化储量: z.coerce.number().prefault(0),
            已解锁长期增益: z.record(z.string(), z.boolean()).prefault(() => ({})),
            首次通关标记: z.boolean().prefault(false),
          }).prefault(() => ({})),
          // 当前启用（重玩中）的时间线编号（4 位数字字符串；'' = 没在重玩）。
          // `_` 前缀 = AI 只读可见：让它知道"现在是在重玩某条已通关的世界线"；
          // 前端据它锁死 出门探索 / 难度 / 设置基底 / 晋升 / 熔断。
          // ⚠ 长线数据（不随本局复位），与 $时间线记忆库 同寿命。
          _当前启用时间线: z.string().prefault(''),

          // ═══ ③ 纯前端区（$ 前缀：AI 不可见；前端算/存）═══
          $切片: z.object({
            $active: z.boolean().prefault(false),
            $status: z.string().prefault('out_of_game'),
            $nodeData: z.any().prefault(null),          // 当前节点数据（类型/编号/遭遇）
            $当前时间点: z.coerce.number().prefault(1094), // 本节点权威年份（收藏品年份对撞用）
            $当前敌方: z.string().prefault(''),
            $软硬: z.string().prefault('硬'),             // 软/硬战报（由所知阈值决定）
            $原定角色: z.string().prefault(''),           // 本节点原定目标（进节点遭遇名；额外收服判定用）
            $收服基线: z.array(z.string()).prefault(() => []),  // 进节点时 干员编队 的键快照
            $额外收服完成: z.boolean().prefault(false),
            $变奏用尽: z.boolean().prefault(false),       // 本节点额外探索已耗尽（收服第二个角色后置真）：前端据此给每条出站消息前置预填充战报；离开/进新节点复位
            $锁定: z.boolean().prefault(false),           // 剧情操作锁定（只留离开/调试）。⚠ 变奏收束**不再置位**：那会连输入框/纯交流一起锁死
            $待定: z.boolean().prefault(false),           // 已进入收束态、待玩家自行离开（出口＝通用离开卡）
            $终局分支: z.string().prefault(''),           // 第5层 boss 进节点时冻结的结局分支：'hidden'(进第六层) | 'finish'(直接结算) | ''(未定)
            $隐藏关: z.string().prefault(''),             // 本节点命中的隐藏关 id（''=没命中）；离节点即清空
          }).prefault(() => ({})),
          // $难度：纯前端区（AI 只读参考，不得写入）。档位 0~5，逐级叠加（见 DifficultyRules）；
          // 分队：'后勤分队'=已实现；其它分队占位（仅在选牌界面显示"敬请期待"，不写入变量）。
          $难度: z.object({ 档位: z.coerce.number().catch(1).prefault(1), 分队: z.string().catch('后勤分队').prefault('后勤分队') }).catch({}).prefault(() => ({})),
          $地图状态: z.object({
            层数: z.coerce.number().prefault(1),
            每列: z.array(z.array(z.object({ type: z.string(), id: z.string() }))).prefault(() => []),
            解锁列数: z.coerce.number().prefault(1),
            当前列: z.coerce.number().prefault(0),
          }).prefault(() => ({})),
          $衰减档: z.coerce.number().prefault(0.8),   // 每通关一层 三维污染 × 衰减档（默认每层削减 20%，纯前端）
          // $短对局（纯前端区）：首页开关，出发时落值。真 = 层序只走 1→3→5（跳过 2/4 层）、
          //   三轴只衰减 2 次、敌池按 SHORT_POOL_MERGE 合并、第 5 层 boss 前固定一个单独诡意行商、
          //   隐藏关概率 ×2。**老档没有这个键 → prefault(false) → 一律按正常对局跑**（零行为变化）。
          //   ⚠ 它属于"开局面板设置"，结束一局时**不**随 _resetEconomyDraft 复位（下次出门沿用上次的选择）。
          $短对局: z.boolean().prefault(false),
          $收藏品获得层: z.record(z.string().describe('收藏品名'), z.coerce.number().describe('获得层数')).prefault(() => ({})), // 长期型收藏品获得层数（逐层削减重放用，纯前端登记）
          // $隐藏关（纯前端区）：三类隐藏世界线**本局是否已经"到手"**。
          //   f = 随机渠道开放、AI 不知情（只由进节点战报交代"此刻怎么写"）；
          //   t = 对应收藏品已到账 → 该族渠道关闭，并由用户自建 EJS 条目接管"这条世界线怎么写"。
          //   EJS 读法：getvar('stat_data.$隐藏关.海嗣', { defaults: false })
          //   ⚠ 这是**本局进度**，不是长期收藏：本局结束（通关/失败/熔断/开新局）即复位成 false，
          //     与 收藏品 同寿命。跨局长留的只有 蚀刻章（含「灭世圣女-救世魔王」）。
          $隐藏关: z.object({
            海嗣: z.boolean().prefault(false),
            月光: z.boolean().prefault(false),
            特殊源石: z.boolean().prefault(false),
          }).prefault(() => ({ 海嗣: false, 月光: false, 特殊源石: false })),

          // ═══ 叙事/长线（无前缀，AI 可读写）═══
          // 剧情日志 = **本局流水**：只有 `年,月,日` → 剧情内容，没有其它固定字段。
          // 动态键容器 → 值类型用最宽容的 z.any（由 AI 整块写，zod 只管兜底不丢数据）。
          剧情日志: z.record(z.string(), z.any()).prefault(() => ({})),
          // $时间线记忆库（纯前端区，AI 不可见）：**长线归档区**，每次通关/存档把本局剧情日志整段搬进来。
          //   { "<四位随机编号>": { "年,月,日": 剧情内容 } }
          //   对 AI 隐藏是作者拍板：存档里所有世界线直接可见会把上下文搅乱；
          //   需要 AI 知道某条线时，由世界书 EJS 按 `_当前启用时间线`（或玩家消息里的编号）定点注入。
          $时间线记忆库: z.record(z.string(), z.any()).prefault(() => ({})),
        }).prefault(() => ({}));
      })();
    }
  } catch (e) {
    console.warn('[集成战略] Schema 构建失败（环境可能无全局 z），已跳过 schema 注册。', e.message);
    Schema = null;
  }
  // 注册（若环境就绪）：等 Mvu 待命后注册，避免时机问题
  setTimeout(() => {
    try {
      if (Schema && typeof registerMvuSchema === 'function') {
        registerMvuSchema(Schema);
        console.info('[集成战略] MVU 变量结构已注册。');
      }
    } catch (e) { console.warn('[集成战略] registerMvuSchema 失败（可能未安装 MVU），游戏仍可运行。'); }
  }, 0);


  // -----------------------------------------------------------------------------------------
  // 宿主全局状态（脚本层，供 iframe 内游戏引用）
  // -----------------------------------------------------------------------------------------
  const State = {
    currentStatus: 'out_of_game', // 状态机
    currentLayer: 1,
    selectedNode: null,
    interactionTarget: '',
    currentNodeData: null, // 当前节点数据（含遭遇/时间点），由 _enterNode 注入
    nodeType: '',          // 当前节点类型
    gameOpened: false,     // 是否已开局（进入过地图/编队）
    busyPhase: 'idle',     // AI 生成状态：idle | generating（生成中锁定发送等）
    genAt: 0,              // 上次进入 generating 的时间戳（用于卡死兜底解锁）
    pendingNoBusyUntil: 0, // 抑制窗口截止时间戳：刚收到 AI 回复/生成结束后，短时间内的 STARTED 会被忽略
    armed: false,          // 白名单门控：本端已主动发起一次生成，等待 GENERATION_STARTED 认领
    armedAt: 0,            // 发起时间戳：超过 ARMED_TIMEOUT_MS 未被认领则作废（触发失败/被吞）
    pendingSend: false,    // 发送中守卫：确认后置位、提交完成清除，防双击/连点重复拼战报
    nodeUI: null,          // （暂留）旧节点界面状态位，新方案逐步弃用
    // 聊天分页：默认只渲染最后 chatVisible 楼；顶部「更多」按钮每次再加载 10 楼。
    chatClean: [],         // 清洗后的全部消息 [ {role,name,text,id,isStructured} ]
    chatVisible: 10,       // 当前可视（最底部）消息条数
    CHAT_PAGE: 10,         // 每次「更多」追加条数
    // 地图进度内存缓存：本局会话内权威来源，防止变量持久化时序导致"离开节点后地图重新生成"。
    mapCache: null,        // { 层数, 每列, 解锁列数, 当前列 }
    entryRoster: null,     // 进节点时的干员编队深拷贝快照（离开节点时若编队被意外清空则回填，防丢干员）
    // 开局选择（界面层暂存）：难度只在"开始游戏"时落变量；分队由分队选牌界面写入。
    prepStep: 'squad',     // preparation 的子步骤：'squad'=分队选牌 / 'roster'=编队
    // 编队页「从标本库挑选」当前展开的时间线编号（纯界面态）：
    //   '' = 没点过 → 自动落到第一条有干员的时间线。
    //   只决定这一栏显示哪条线上的干员，**不写任何变量**（标本库 / $时间线名称 都只读）。
    prepSpecTl: '',
    pendingDifficulty: null, // 主界面难度按钮选中的档位（未开始游戏前不入变量，null=跟随存档/默认）
    pendingSquad: null,      // 分队选牌界面选中的分队 KEY（同上）
    // 短对局开关（首页滑块）：null = 还没点过 → 跟随变量 `$短对局`（上次出门的选择）；
    //   true/false = 本次已点过，出发时以它为准写进 `$短对局`。
    pendingShortRun: null,
    // 失败锁定态（**纯内存临时态，不写任何变量**）：
    //   核心生命归零时置真 —— 不立刻退首页，而是冻结操作、只留一个「返回罗德岛」按钮，
    //   让玩家还能翻聊天记录 / 看编队。点那个按钮才真正 _resetRun() 回主城。
    //   ⚠ 关窗口重开不走这条：恢复路径发现 核心生命 ≤ 0 会直接复位回主城（见 _restoreGameState）。
    failed: false,
    // 新手建档标记：<确认并出发> 置真，进第一个节点时消费（标本库为空 → 战报附建档指令）。
    // 只存会话内内存（重开窗口不丢，重开脚本即清，正好配合"每局出发重新置真"）。
    firstNodePending: false,
    // ── 剧情日志变更播报（弹窗 + 时间轴页）──────────────────────────────
    //   指纹快照＝「日志键 → 该条正文」，只存字符串，绝不存变量活对象。
    //   比较快照即可判定：键是新的＝新增剧情；键在、值变了＝日志更新（AI 收坑/覆写同一键）。
    //   同时天然去重：重排（_sortChronicle 只改键序不改值）与前端写回都不会误弹。
    chronicleFp: null,        // 上一次快照（Map）；null = 还没建基线
    chronicleQueue: [],       // 待播的卡片队列（按世界历升序入队，逐张串行播）
    chroniclePlaying: false,  // 队列播放中守卫
    // ── 重玩模式兜底（见 _replayDriftCheck / _withReplayFix）──────────────
    replaySnap: null,         // 进入重玩时的 玩家资源/收藏品/蚀刻章/编队键 快照
    replayFixPending: false,  // 本回合纠正过越权改动 → 下一条出站消息前置隐藏说明
    // ── 标本室页（折叠树）的界面态：纯内存，关脚本即清 ──────────────────────
    //   specOpen：折叠开关表。键 'r:编号' = 一级时间线行；'s:编号:line' / 's:编号:spec' = 两个二级栏；
    //             's:anomaly' = 异常组。默认全收起（不存在即收起）。
    //   specSel / specMode / _specElite：左栏详情选中的卡 / 页签（数值|叙事）/ 精一精二胸像档位。
    specOpen: {},
    specSel: '',
    specMode: 'num',
    _specElite: false,
    // ── 节点表现层（纯内存）──────────────────────────────────────────────
    //   nodeConfirm：当前打开的确认栏 { key, type, col, idx }（null = 没开）。
    //   loadingActive：作战伪加载页正在播 → 期间冻结战报卡/日志播报（不叠在加载页上）。
    //   pendingStack / pendingMissionDone：加载期间被压住的动画，加载结束后补播。
    //   missionDoneKey：本节点已完成一次「任务完成」黑条（每节点只播一次）。
    nodeConfirm: null,
    loadingActive: false,
    loadingTimers: [],
    pendingStack: false,
    pendingMissionDone: false,
    missionDoneKey: '',
  };

  // ── AI 生成状态机防护参数 ─────────────────────────────────────────────────
  // 酒馆偶发"AI 输出完成后又莫名其妙补发一次 GENERATION_STARTED"的时序怪癖，
  // 会把「中止」按钮重新点亮、busyPhase 卡在 generating、进而卡死重roll。
  // 对策（双闸）：
  //   ① 白名单 armed：只有**本端主动发起**（发送/选项/重roll/系统消息）才置 armed，
  //      未 armed 的 STARTED（怪癖/时序重置）一律不置忙，并落冷却窗口；
  //   ② 完成/中止后忽略窗口：ENDED/STOPPED/收到AI消息/点中止后，窗口内的 STARTED 直接忽略。
  // 触发点见 _commitPlayerMessage / _sendAsUser / handleReroll（置 armed + 清零窗口放行）。
  const BUSY_SUPPRESS_MS = 8000;    // 完成/中止/怪癖 STARTED 后的忽略窗口（收紧：4s→8s）
  const ABORT_SUPPRESS_MS = 5000;   // 点击「中止」后的忽略窗口（stop 收尾还可能再补一发 STARTED）
  const ARMED_TIMEOUT_MS = 30000;   // armed 有效期：发起后 30s 内未被 STARTED 认领即作废（触发失败/被吞）
  const BUSY_WATCHDOG_MS = 3 * 60 * 1000;  // 思考态持续上限（收紧：6min→3min），超过视为卡死强制复位
  let busyWatchdog = null;          // 看门狗 interval（宿主脚本级单例，重开窗口不重复建）

  // ─────────────────────────────────────────────────────────────────────────────
  // 晋升消耗（唯一权威口径：**只由前端扣减**）
  //   - 默认 4 源石/人；难度 4 起为 5 源石/人（见 DifficultyRules）。
  //   - 严禁任何其它路径（AI/镜像逻辑）重复扣减淫堕源石；战报中必须明示"费用已扣完"。
  // ─────────────────────────────────────────────────────────────────────────────
  const PROMOTE_COST_DEFAULT = 4;

  // ─────────────────────────────────────────────────────────────────────────────
  // 难度规则表（纯前端叠加；每级叠加所有上级难度效果；难度 0 = 一切不变）
  //   效果数组同时用于：难度轮盘 UI 文案 + 战报中给 AI 的说明（AI 无需自行实现，前端已算）。
  //   ⚠ 全部效果都是"额外修正"，不是永久修改，且**不会累积**：
  //      主城里改难度/分队只更新内存暂存值，不碰经济；唯一落值点是「确认并出发」——
  //      那一刻先 `_resetRunScopedDraft()` 把经济复位成初始值，再由 `_runDelta()` 加一份修正。
  //      因此反复出发 / 来回切难度永远只等于"初始值 + 当前这一份"，选回难度 0 就完整回到初始值。
  // ─────────────────────────────────────────────────────────────────────────────
  const DifficultyRules = {
    1: { 效果: ['初始核心生命 -4'] },
    2: { 效果: ['每层三轴削减：20% → 25%'] },
    3: { 效果: ['每过一层：我方战力 −1（仅影响长期池战力，不改干员数值）'] },
    4: { 效果: ['晋升干员消耗：4 源石 → 5 源石 / 人'] },
    5: { 效果: ['对战时须同时拥有 2 条轴优势，才判定为「优势」'] },
    6: { 效果: ['「所知」对我方战力的加减反转：所知为正 → 倒扣我方去量化；所知为负 → 增益'] },
  };

  // 分队（横向大字选牌界面）。enabled=false → 显示「敬请期待」，不可点选。
  //   预留扩展：以后实现更多分队时在此表追加条目，并在 _applyRunDifficulty 内处理效果即可。
  const SQUADS = [
    {
      key: '后勤分队', 名: '后勤分队', enabled: true, 图标: 'triangle',
      标语: '补给先行', 描述: '初始源石 +2，精液 +20',
      详述: '开局补给（切换分队会回退上一支分队的补给，不会累积）。',
      done: true,
    },
    {
      key: '指挥分队', 名: '指挥分队', enabled: true, 图标: 'diamond',
      标语: '以战养战', 描述: '每离开一个作战节点（作战 / 紧急作战 / 险路恶敌）：核心生命 +1',
      详述: '不期而遇转对战不算；没有开局加成。离开即回血，由前端直接写变量（见 _commandSquadLeaveBonus）。',
      done: true,
    },
    { key: '集群分队',  名: '集群分队',   enabled: false, 图标: 'walls',    标语: '可携带干员 +2',  描述: '可携带干员 +2，同时部署人数 +2' },
    { key: '矛头分队',  名: '矛头分队',   enabled: false, 图标: 'crosshair', 标语: '目标生命变为 1', 描述: '目标生命变为 1，所有干员攻击力 +15%，生命 +15%' },
    { key: '突击战术分队', 名: '突击战术分队', enabled: false, 图标: 'shards',  标语: '高级干员开局',  描述: '开局获得 1 名高级干员，并获得额外增益' },
  ];

  /** 分队图标：纯 SVG（不依赖外部图源）；后勤分队＝大三角形，其余为占位图案 */
  function squadIconSVG(kind, size) {
    const s = size || 64;
    const open = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 64 64" fill="none">';
    const common = 'stroke="#dfe8f5" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"';
    if (kind === 'triangle') {   // 后勤分队：大三角形（带内三角，呼应符文感）
      return open + '<path d="M32 7 L58 55 L6 55 Z" fill="rgba(190,215,245,.10)" ' + common + '/>'
        + '<path d="M32 21 L48 49 L16 49 Z" fill="rgba(190,215,245,.14)" ' + common + '/></svg>';
    }
    if (kind === 'diamond') {
      return open + '<path d="M32 8 L54 32 L32 56 L10 32 Z" fill="rgba(190,215,245,.10)" ' + common + '/>'
        + '<circle cx="32" cy="32" r="6" ' + common + '/></svg>';
    }
    if (kind === 'walls') {
      return open + '<path d="M12 20 h40 M12 32 h40 M12 44 h40 M24 20 v12 M44 20 v12 M16 32 v12 M36 32 v12" ' + common + '/></svg>';
    }
    if (kind === 'crosshair') {
      return open + '<circle cx="32" cy="32" r="16" ' + common + '/>'
        + '<path d="M32 6 v12 M32 46 v12 M6 32 h12 M46 32 h12" ' + common + '/>'
        + '<circle cx="32" cy="32" r="3" fill="#dfe8f5"/></svg>';
    }
    // shards：斜纹碎片（占位）
    return open + '<path d="M32 6 L40 30 L32 58 L24 30 Z" fill="rgba(190,215,245,.10)" ' + common + '/>'
      + '<path d="M14 46 l18 -8 M50 46 l-18 -8" ' + common + '/></svg>';
  }

  /** 难度叠加计算上下文（系数类效果；供 _recomputeLongPool / _evalBattle 使用） */
  function diffCtx(level) {
    const lv = Math.max(0, Math.min(6, Math.trunc(Number(level)) || 0));
    return {
      档位: lv,
      decay: lv >= 2 ? 0.75 : 0.8,              // 每层三轴削减
      layerPowerPenalty: lv >= 3 ? 1 : 0,       // 每过一层：长期池战力 −1（不改干员数值）
      promoteCost: lv >= 4 ? 5 : PROMOTE_COST_DEFAULT,
      needAxes: lv >= 5 ? 2 : 1,                // 判定「优势」所需优势轴数
      knownReverse: lv >= 6,                    // 「所知」加减反转
      hpPenalty: lv >= 1 ? 4 : 0,               // 开局核心生命扣减
    };
  }

  /** 晋升计价的「人话」版本 —— 写进 AI 可见变量 `_探索进程._晋升花费`。
   *  为什么不是裸数字：AI 读到的若是 `晋升单价: 5`，很容易被上下文稀释或误读成"五折/五次"；
   *  整句陈述的权重更高，且天然自带"一次性 / 每人 / 已晋升不重复收费"的限定。
   *  价格本身仍**只**由 diffCtx() 决定（唯一权威），本函数只负责措辞。 */
  function promoteSentence(cost) {
    const n = Math.max(0, Math.round(Number(cost) || PROMOTE_COST_DEFAULT));
    return '当前非购买特定商品/选项时，普通晋升干员花费为一次性 ' + n + ' 淫堕源石/人（已晋升过的干员不再收费）。';
  }

  let gameIframe = null;

  // =========================================================================================
  // 【模块1.2：界面密度（手机端紧凑档）】
  //   为什么需要它：手机横屏的 CSS 视口是「又宽又矮」（实测约 873×393，DPR≈2.75），
  //   宽度够不着 760/640/560/400 那几档断点，只有 900 一档生效 —— 也就是说手机横屏吃的
  //   基本是桌面排版，而桌面排版是按 800~1000px 高设计的，塞进 393px 必然"元素过大、挤在一起"。
  //   所以判定必须**以视口高度为主、且只在触屏上生效**：
  //     coarse && innerHeight ≤ 640  →  加 body.ui-compact（紧凑档，见 compactStyles）
  //   桌面（鼠标/触控板 → pointer:fine、hover:hover）永远不命中，电脑端排版不受任何影响。
  //   两次误判保险：① 判定要求 innerWidth ≤ 1100（触屏笔记本 ≥1280 一律排除）；
  //                ② 手机上顶栏下方会出现一颗小小的「密度·自动/桌面/紧凑」按钮（仅触屏设备创建），
  //                   点一下就能切回桌面排版，另有 Shift+M（键盘）与 ?jczl_ui=desktop|compact 强制。
  // =========================================================================================
  const UI_DENSITY_KEY = 'jczl.uiDensity';   // auto | desktop | compact
  let _uiDensityPref = null;                 // 内存缓存（localStorage 不可用时也能工作）
  let _uiDensityUrlPref = '';                // ?jczl_ui=... 一次性强制（从宿主 URL 读）

  function isCoarsePointer(win) {
    try {
      if (!win.matchMedia) return false;
      return !!(win.matchMedia('(pointer: coarse)').matches || win.matchMedia('(hover: none)').matches);
    } catch (e) { return false; }
  }

  function readUiDensityPref(win) {
    if (_uiDensityPref !== null) return _uiDensityPref;
    let v = '';
    if (_uiDensityUrlPref) v = _uiDensityUrlPref;
    if (!v) { try { v = String(win.localStorage.getItem(UI_DENSITY_KEY) || ''); } catch (e) {} }
    _uiDensityPref = (v === 'desktop' || v === 'compact') ? v : 'auto';
    return _uiDensityPref;
  }

  function writeUiDensityPref(win, v) {
    _uiDensityPref = (v === 'desktop' || v === 'compact') ? v : 'auto';
    try { win.localStorage.setItem(UI_DENSITY_KEY, _uiDensityPref); } catch (e) {}
  }

  /**
   * 「触屏 + 手机/平板尺寸」：紧凑档判定与密度开关按钮的共同门槛。
   *   · innerWidth ≤ 1100 把"触屏笔记本/触屏一体机"排除在外（这类宽 ≥1280，仍走桌面排版）；
   *   · 真被误判时 Shift+M（键盘）或本机密度开关按钮可手动改回"桌面"。
   */
  function isTouchSized(win) {
    return isCoarsePointer(win) && Number(win.innerWidth || 0) <= 1100;
  }

  /**
   * 自动档的判定：触屏 + 矮视口。
   *   · innerHeight ≤ 640：手机横屏实测约 393、竖屏约 873 → 只认"矮"这一条就够，
   *     也正因如此，竖屏手机不会被误判成紧凑（竖屏走原来的 640/560/400 那几档断点）。
   * 返回是否应进入紧凑档。
   */
  function detectCompact(win) {
    return isTouchSized(win) && Number(win.innerHeight || 0) <= 640;
  }

  /** 密度开关按钮（只在触屏设备出现；点一下循环 自动→桌面→紧凑）。桌面浏览器永不创建 */
  function syncDensityChip(win) {
    try {
      const d = win.document;
      if (!d || !d.getElementById) return;
      const want = isTouchSized(win);
      let el = d.getElementById('ui-density-chip');
      if (!want) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
      if (!el) {
        el = d.createElement('div');
        el.id = 'ui-density-chip';
        el.title = '界面密度：自动 / 桌面 / 紧凑（点一下切一档）';
        el.onclick = () => { try { Router._cycleUiDensity(); } catch (e) {} };
        (d.getElementById('root') || d.body).appendChild(el);
      }
      const pref = readUiDensityPref(win);
      el.textContent = '密度·' + ({ auto: '自动', desktop: '桌面', compact: '紧凑' }[pref] || '自动');
    } catch (e) {}
  }

  /** 按偏好 + 实测视口给 body 打/摘 ui-compact（并把密度开关按钮摆好）。返回当前是否紧凑 */
  function applyUiDensity(win) {
    const pref = readUiDensityPref(win);
    const on = pref === 'compact' || (pref === 'auto' && detectCompact(win));
    try {
      if (win.document && win.document.body) {
        win.document.body.classList.toggle('ui-compact', on);
        win.document.body.classList.toggle('ui-touch', isTouchSized(win));
      }
    } catch (e) {}
    syncDensityChip(win);
    return on;
  }

  /** --vh：iframe 实测 1% 高度。移动端地址栏伸缩时 vh 会算多，底部输入行会被顶出可视区 */
  function setViewportVars(win) {
    try {
      const h = Number(win.innerHeight || 0);
      // 视口退化（窗口最小化 / iframe 被隐藏 → innerHeight 接近 0）时**不写**：
      // 一旦写成 0px，所有 calc(var(--vh) * N) 会一起塌成 0（立绘层高度也归零），
      // 而且它不像内联尺寸那样会自己长回来。保留上一次的正常值更安全。
      if (!(h >= 200)) return;
      win.document.documentElement.style.setProperty('--vh', (h / 100) + 'px');
    } catch (e) {}
  }

  /** 视口自检数据（排查"为什么手机上还是大/为什么桌面变小了"一眼够用） */
  function viewportInfo(win) {
    const d = win.document;
    const rect = (sel) => {
      try {
        const el = d.querySelector(sel);
        if (!el || !el.getBoundingClientRect) return '(无)';
        const r = el.getBoundingClientRect();
        return `${Math.round(r.width)}×${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
      } catch (e) { return '(错)'; }
    };
    return {
      视口: `${win.innerWidth}×${win.innerHeight}`,
      DPR: win.devicePixelRatio,
      触屏: isCoarsePointer(win),
      密度偏好: readUiDensityPref(win),
      紧凑生效: !!(d.body && d.body.classList.contains('ui-compact')),
      '顶栏#top-bar': rect('#top-bar'),
      '聊天#chat-container': rect('#chat-container'),
      'gal#gal-layer': rect('#gal-layer'),
      '雷达.radar-panel': rect('.radar-panel'),
      '选项栏#option-rail': rect('#option-rail'),
      // 右下角操作列的锚点链：万一按钮没贴住屏幕底，一比就知道是哪个祖先的高度不对
      '主内容#main-content': rect('#main-content'),
      '主城.home-view': rect('.home-view'),
      '右下列.home-side': rect('.home-side'),
      '右下列.sq-btns': rect('.sq-btns'),
    };
  }

  /** 打开界面时调用一次：写 --vh、打密度类、挂 resize/旋转/全屏监听（监听只注册一次） */
  function initViewportAdapt(win) {
    if (!win || win._dshViewportBound) { setViewportVars(win); applyUiDensity(win); return; }
    win._dshViewportBound = true;
    const reflow = () => {
      setViewportVars(win); applyUiDensity(win);
      // gal 窗口的让位是 JS 量出来的 inline bottom/right（见 _galLayout）：密度/视口一变就得重量一次，
      // 否则旋转屏幕后旧值会把对话框压到输入行上。
      try { Router._galLayout(); } catch (e) {}
      // 诡意行商的「确认购买」盖板：视口/密度变了要按新矩形重贴（radar 也跟着 --right-col 变宽窄）
      try { Router._syncShopBuyBtnPos(); } catch (e) {}
    };
    // 增稳：resize 会连续触发几十次，中途量到的尺寸往往是"没稳定"的值（拖动窗口、Scrollbar 出现、
    // 浏览器侧栏动画……）。所以立刻量一次给手感，再补两次"稳定后复量"，让最终值一定来自稳定布局；
    // 计时器挂在 iframe 自己的 window 上，iframe 销毁后自动失效（不会碰到已销毁的 document）。
    const tset = (fn, ms) => {
      try { return (win.setTimeout || setTimeout)(fn, ms); } catch (e) { return setTimeout(fn, ms); }
    };
    const tclr = (id) => {
      try { (win.clearTimeout || clearTimeout)(id); } catch (e) { try { clearTimeout(id); } catch (e2) {} }
    };
    let _rfT1 = 0, _rfT2 = 0;
    const reflowSettle = () => {
      reflow();
      tclr(_rfT1); _rfT1 = tset(reflow, 120);
      tclr(_rfT2); _rfT2 = tset(reflow, 420);
    };
    reflowSettle();
    if (win.addEventListener) {
      win.addEventListener('resize', reflowSettle);
      win.addEventListener('orientationchange', reflowSettle);
    }
    // 切走/切回标签页、iframe 从隐藏变可见：这两件事都不一定触发 resize，
    // 但都会让"当时量到的尺寸"变成废值 —— 回来时补量一次。
    try { win.document.addEventListener('visibilitychange', reflowSettle); } catch (e) {}
    try { win.addEventListener('pageshow', reflowSettle); } catch (e) {}
    try { win.addEventListener('focus', reflowSettle); } catch (e) {}
    try { win.document.addEventListener('fullscreenchange', reflowSettle); } catch (e) {}
    // 控制台手动切换：setUiDensity('desktop' | 'compact' | 'auto')
    win.setUiDensity = (v) => { writeUiDensityPref(win, v); return reflow() || viewportInfo(win); };
  }

  // =========================================================================================
  // 【模块1：宿主层 —— 按钮 + 全屏画布 + 接口注入】
  // =========================================================================================
  function closeGame() {
    if (gameIframe) {
      gameIframe.remove();
      gameIframe = null;
      syncOpenButton();
      console.info('[集成战略] 全屏画布已销毁');
    }
  }

  /** 切换脚本按钮为「打开」状态 */
  function syncOpenButton() {
    updateScriptButtonsWith((buttons) => {
      const b = buttons.filter((x) => x.name !== '关闭集成战略');
      if (!b.some((x) => x.name === '打开集成战略')) b.push({ name: '打开集成战略', visible: true });
      return b;
    });
  }

  /** 切换脚本按钮为「关闭」状态 */
  function syncCloseButton() {
    updateScriptButtonsWith((buttons) => {
      const b = buttons.filter((x) => x.name !== '打开集成战略');
      if (!b.some((x) => x.name === '关闭集成战略')) b.push({ name: '关闭集成战略', visible: true });
      return b;
    });
  }



  let opening = false;   // 开局进行中守卫（防连点/重复开局）
  function openGame() {
    if (gameIframe || opening) return;
    opening = true;
    try { mergeCustomPoolsFromVars(); } catch (e) { console.warn('[集成战略] 自定义干员池读取异常，已跳过。', e); }
    // 干员开关表：开局就把「旧聊天变量 → 角色卡变量」的一次性迁移 / 建表做掉。
    // 必须早于任何一次抽取（节点遭遇 / boss / 闲暇娱乐 / 开局出身都会读它）；
    // 用 reload 而不是 read：玩家可能中途换过角色卡（cache 里是上一张卡的表），
    // 开局必须按"当前这张卡"重读一遍。写失败也不拦开局 —— 读路径会自行回退到"全员启用"。
    try { reloadSwitchTable(); } catch (e) { console.warn('[集成战略] 干员开关表载入异常，按「全员启用」继续。', e); }
    opening = false;
    if (gameIframe) return;

    // ?jczl_ui=desktop|compact 一次性强制界面密度（从宿主 URL 读；iframe 里读不到 search）
    try {
      const m = /[?&]jczl_ui=(auto|desktop|compact)/.exec(String(window.location.search || ''));
      _uiDensityUrlPref = m ? m[1] : '';
    } catch (e) { _uiDensityUrlPref = ''; }

    gameIframe = document.createElement('iframe');
    gameIframe.style.cssText = [
      'position: fixed', 'top: 0', 'left: 0', 'width: 100vw', 'height: 100vh',
      /* dvh 放在 vh 之后：移动端地址栏伸缩时若仍按 100vh 定高，底部输入行会被顶出可视区。
         （不认 dvh 的旧浏览器会丢弃这条声明，退回上面的 100vh。） */
      'height: 100dvh',
      'z-index: 999999', 'border: none', 'background-color: #000',
    ].join(';');

    // script_id 隔离 + 允许内部进行浏览器全屏
    gameIframe.setAttribute('script_id', SCRIPT_ID);
    gameIframe.setAttribute('allow', 'fullscreen');
    gameIframe.setAttribute('allowfullscreen', 'true');
    window.parent.document.body.appendChild(gameIframe);

    const doc = gameIframe.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html lang="zh-CN"><head><style>${globalStyles}${compactStyles}</style></head><body></body></html>`);
    doc.close();
    gameIframe.contentWindow.addEventListener('load', () => {
      // 将酒馆样式传入 iframe，保证复用主题变量
      if (window.teleportStyle) window.teleportStyle(gameIframe.contentDocument.head);
    });

    // 把宿主接口注入 iframe 的顶层（供 iframe 内游戏使用）
    const win = gameIframe.contentWindow;
    win.closeGame = closeGame;
    win.getScriptId = () => SCRIPT_ID;
    const injected = [
      'Mvu', 'getVariables', 'updateVariablesWith', 'replaceVariables', 'insertOrAssignVariables',
      'insertVariables', 'deleteVariable', 'eventOn', 'eventEmit', 'eventRemoveListener',
      'tavern_events', 'iframe_events', 'triggerSlash', 'getChatMessages', 'setChatMessages',
      'createChatMessages', 'deleteChatMessages', 'getLastMessageId', 'builtin', 'SillyTavern',
      'prompt', 'confirm', 'reloadIframe', 'teleportStyle', 'getScriptId',
    ];
    injected.forEach((k) => {
      if (typeof window[k] !== 'undefined') win[k] = window[k];
    });

    // 界面密度必须在 Router.init **之前**定下来：地图连线坐标是渲染时按当时的节点尺寸算的，
    // 晚一步打类会让 SVG 箭头按旧布局错位（见 _drawMapLinks / _bindMapResize 的注释），
    // 也会让手机端先按桌面排版闪一帧。此处 body 已由 doc.write 建好，直接可用。
    initViewportAdapt(win);
    Router.init(win);
    // renderBaseUI 会重建 #root，密度开关按钮可能被一起清掉 → 补一次（只在触屏设备出现）
    syncDensityChip(win);
    syncCloseButton();
  }

  // ---------------------------------------------------------------------------------------
  // 脚本按钮注册
  // ---------------------------------------------------------------------------------------
  replaceScriptButtons([
    { name: '打开集成战略', visible: true },
    { name: '关闭集成战略', visible: false },
  ]);

  eventOn(getButtonEvent('打开集成战略'), openGame);
  eventOn(getButtonEvent('关闭集成战略'), closeGame);
  eventOn(tavern_events.CHAT_CHANGED, closeGame);
  $(window).on('pagehide', closeGame);

  // ---- 玩家用户名（酒馆当前 User 名：persona 模式下即当前所选 persona 名，否则主设置 user_name；= {{User}} 宏真值）----
  // 用途：写入用户消息的 name 时用真实用户名（显示与提示词都正确），不再落 {{User}}/&lt;user&gt; 占位。
  // 捕获链（按可靠性排序）：
  //   ① substitudeMacros('{{User}}') —— 酒馆助手官方宏替换接口，让 ST 自己把 {{User}} 展开为当前 User 名；
  //   ② CHAT_COMPLETION_SETTINGS_READY  —— 每次发起 AI 回复前酒馆广播 generate_data.user_name，
  //      天然等于"这一次生成所见到的 User 名"，前端触发回复时同步刷新最贴切；
  //   ③ SETTINGS_LOADED_AFTER → settings.user_name（主设置兜底）；
  //   ④ SillyTavern.name1 等运行时全局兜底（宿主/主窗口可达）；
  //   ⑤ 全失败 → '{{User}}' 占位（消息保存侧 ST 的宏引擎仍会展开）。
  let _userName = '';
  function pickUserName() {
    // ① 官方宏展开：让酒馆按当前选中状态展开 {{User}}（persona 切换后调用即拿到新名字）
    try {
      if (typeof substitudeMacros === 'function') {
        const n = String(substitudeMacros('{{User}}') || '').trim();
        if (n && n !== '{{User}}') return n;
      }
    } catch (e) {}
    // ④ 酒馆运行时全局（宿主窗口或主窗口上的 SillyTavern 对象）
    try {
      const w = (typeof window !== 'undefined') ? window : null;
      const st = (w && w.SillyTavern)
        || (w && w.parent && w.parent.SillyTavern)
        || (w && w.top && w.top.SillyTavern) || null;
      const n = st && typeof st.name1 === 'string' ? st.name1 : '';
      if (n && n.trim()) return n.trim();
    } catch (e) {}
    return '';
  }
  function getUserName() { return _userName || pickUserName() || '{{User}}'; }
  // 启动即同步一次（脚本运行时酒馆主窗口已就绪）；主设置加载完成再兜底补一次
  try { if (pickUserName()) _userName = pickUserName(); } catch (e) {}
  try {
    eventOn(tavern_events.SETTINGS_LOADED_AFTER, (settings) => {
      try {
        const n = (settings && (settings.user_name || settings.userName)) || '';
        if (typeof n === 'string' && n.trim()) _userName = n.trim();
      } catch (e) {}
      try { const n = pickUserName(); if (n) _userName = n; } catch (e2) {}
    });
  } catch (e) {}
  // ② 每次生成前酒馆广播的请求参数里带当前 user_name：直接以它为准刷新（最贴"当前选择的 User"）
  try {
    eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, (data) => {
      try {
        const n = data && typeof data.user_name === 'string' ? data.user_name.trim() : '';
        if (n) _userName = n;
      } catch (e) {}
    });
  } catch (e) {}

  // =========================================================================================
  // 【模块2.5：干员池 / 敌方池 / 隐藏层接口】
  //   干员池与敌方池结构见「干员池_映射草案.md」。图链缺失项用 '' 或 TODO 占位。
  //   创意工坊：本地自定义干员池由 jczl_workshop.js 写入变量（jczl_custom_pool，角色卡优先/全局兜底），主文件开局读变量合入，见文内【创意工坊】模块。
  // =========================================================================================
  const Q_URL = 'https://gcore.jsdelivr.net/gh/ll11292631-droid/i-am-daddy@main/';
  const A_URL = 'https://gcore.jsdelivr.net/gh/ll11292631-droid/i-am-daddy@ava/';
  const getAva = (name, custom) => (custom ? A_URL + custom : `${A_URL}头像_${name}.png`);

  // ---- 干员池 OperatorDB -------------------------------------------------------------
  //  图链口径（本轮改造）：
  //    · 每条带 id 的条目走外站 ArknightsGameResource，URL 由 id 现拼（不再手写文件名）。
  //    · full=true  = 外站精1/精2立绘齐全 → 晋升后**立绘与头像都换成_2（精二）**。
  //    · full=false = 外站不全 → 用外站或不带外站，**晋升不变图**。
  //    · id 为空   = 外站没有这个角色（剧情NPC/本作原创）→ 保留原来的手写链，指向用户自己的站。
  //  加速一律走 gcore（保险）。
  const AK_URL = 'https://gcore.jsdelivr.net/gh/yuanyan3060/ArknightsGameResource@main/';

  const OperatorDB = {
    "阿米娅": { q: '', a: '', bg: '', id: 'char_002_amiya', full: true },
    // 终曲阿米娅（统一命名，旧写法「阿米娅_炉芯终曲」已弃用）：外站虽有 char_002_amiya，但立绘用炉芯终曲同人稿 →
    //  走自备素材固定不换（用户仓库主分支 main）。
    //  胸像 Avg_avg_npc_6666_1-1$1 (1)(1).png ／ 头像 Avg_avg_npc_6666_1-1$1.png
    "终曲阿米娅": { q: Q_URL+'Avg_avg_npc_6666_1-1$1 (1)(1).png', a: Q_URL+'Avg_avg_npc_6666_1-1$1.png', bg: '', id: '', full: false },
    // 凯尔希：整条走外站异格形态 char_1052_kalts2（后缀逻辑与原 id 完全一致：
    //  portrait_1/_2 作胸像、avatar_2 作头像）。比 char_003_kalts 更贴"这个角色"。
    "凯尔希": { q: '', a: '', bg: '', id: 'char_1052_kalts2', full: true },
    "空": { q: '', a: '', bg: '', id: 'char_101_sora', full: true },
    "狮蝎": { q: '', a: '', bg: '', id: 'char_215_mantic', full: true },
    "夜莺": { q: '', a: '', bg: '', id: 'char_179_cgbird', full: true },
    "塑心": { q: '', a: '', bg: '', id: 'char_245_cello', full: true },
    "缪尔赛思": { q: '', a: '', bg: '', id: 'char_249_mlyss', full: true },
    "安洁莉娜": { q: '', a: '', bg: '', id: 'char_1015_aglna2', full: true },
    "洁尔佩塔": { q: Q_URL+'port_char_gilb.webp', a: Q_URL+'ava_char_gilb.webp', bg: '', id: '', full: false },
    // 普瑞赛斯：外站无此角色（官方角色表里没有），用用户自备素材固定不换。
    //  两条都在主分支 main（ava 分支没有这两个文件），所以头像不走 getAva，直接拼 @main。
    "普瑞赛斯": { q: Q_URL+'Avg_avg_npc_083(1).png', a: Q_URL+'Avg_avg_npc_083(2).png', bg: '', id: '', full: false },
    "薇薇安娜": { q: '', a: '', bg: '', id: 'char_4098_vvana', full: true },
    "夕": { q: '', a: '', bg: '', id: 'char_2015_dusk', full: true },
    "幽灵鲨": { q: '', a: '', bg: '', id: 'char_143_ghost', full: true },
    "卡莱莎": { q: Q_URL+'edited_image__2_-removebg-preview.png', a: getAva('','Avg_avg_npc_1452_1-1$1.png'), bg: '', id: '', full: false },
    "絮雨": { q: '', a: '', bg: '', id: 'char_436_whispr', full: true },
    "克莱门莎": { q: '', a: '', bg: '', id: 'char_4231_clemnt', full: true },   // 已实装：官方 头像/精1/精2 胸像（见 arknights_avatars index.csv）
    "琴柳": { q: '', a: '', bg: '', id: 'char_479_sleach', full: true },
    "W": { q: '', a: '', bg: '', id: 'char_113_cqbw', full: true },
    // 维什戴尔：死代码搁置（W 的异格名；前端一切以「W」为准，不进池、不注册别名）。
    "维什戴尔": { q: '', a: '', bg: '', id: 'char_113_cqbw', full: true },
    "忍冬": { q: '', a: '', bg: '', id: 'char_4026_vulpis', full: true },
    "铃兰": { q: '', a: '', bg: '', id: 'char_358_lisa', full: true },
    "雷蛇": { q: '', a: '', bg: '', id: 'char_107_liskam', full: true },
    "芙兰卡": { q: '', a: '', bg: '', id: 'char_106_franka', full: true },
    "死芒": { q: '', a: '', bg: '', id: 'char_450_necras', full: true },
    "蓝毒": { q: '', a: '', bg: '', id: 'char_129_bluep', full: true },
    "迷迭香": { q: '', a: '', bg: '', id: 'char_391_rosmon', full: true },
    "晓歌": { q: '', a: '', bg: '', id: 'char_497_ctable', full: true },
    "黍": { q: '', a: '', bg: '', id: 'char_2025_shu', full: true },
    "均": { q: Q_URL+'edited_image__3_-removebg-preview.png', a: getAva('','Avg_avg_npc_2126_1-1$1.png'), bg: '', id: '', full: false },
    "鸿雪": { q: '', a: '', bg: '', id: 'char_4055_bgsnow', full: true },
    "伊内丝": { q: '', a: '', bg: '', id: 'char_4087_ines', full: true },
    "希尔达": { q: Q_URL+'xerd.png', a: getAva('','Avg_avg_npc_2245_1-1$1.png'), bg: '', id: '', full: false },
    "风笛": { q: '', a: '', bg: '', id: 'char_222_bpipe', full: true },
    "霜星": { q: Q_URL+'edited_image__5_-removebg-preview.png', a: getAva('','Avg_char_1505_frstar_1.png'), bg: '', id: '', full: false },
    // 寒灾霜星：与「霜星」是**两个不同角色**（if 线形态），条目单列；按设定只有两者复用同一张头像。
    "寒灾霜星": { q: Q_URL+'edited_image__5_-removebg-preview.png', a: getAva('','Avg_char_1505_frstar_1.png'), bg: '', id: '', full: false },
    "斯卡蒂": { q: '', a: '', bg: '', id: 'char_263_skadi', full: true },
    "浊心斯卡蒂": { q: '', a: '', bg: '', id: 'char_1012_skadi2', full: true },
    "温蒂": { q: '', a: '', bg: '', id: 'char_400_weedy', full: true },
    "羽毛笔": { q: '', a: '', bg: '', id: 'char_421_crow', full: true },
    "多萝西": { q: '', a: '', bg: '', id: 'char_4048_doroth', full: true },
    "白面鸮": { q: '', a: '', bg: '', id: 'char_128_plosis', full: true },
    "泥岩": { q: '', a: '', bg: '', id: 'char_311_mudrok', full: true },
    "蕾缪安": { q: '', a: '', bg: '', id: 'char_4193_lemuen', full: true },
    "能天使": { q: '', a: '', bg: '', id: 'char_1041_angel2', full: true },
    "莫斯提马": { q: '', a: '', bg: '', id: 'char_213_mostma', full: true },
    "mon3tr": { q: '', a: '', bg: '', id: 'char_4179_monstr', full: true },   // 官方名 Mon3tr；全池统一键名 mon3tr（图池目录 m3 亦归并于本键）
    "斥罪": { q: '', a: '', bg: '', id: 'char_4065_judge', full: true },
    "白金": { q: '', a: '', bg: '', id: 'char_204_platnm', full: true },
    "桃金娘": { q: '', a: '', bg: '', id: 'char_151_myrtle', full: true },
    "初雪": { q: '', a: '', bg: '', id: 'char_174_slbell', full: true },
    "史尔特尔": { q: '', a: '', bg: '', id: 'char_350_surtr', full: true },
    "惊蛰": { q: '', a: '', bg: '', id: 'char_306_leizi', full: true },
    "菈玛莲": { q: Q_URL+'edited_image__4_-removebg-preview.png', a: getAva('','Avg_avg_npc_1071_1-1$1.png'), bg: '', id: '', full: false },
    "深靛": { q: '', a: '', bg: '', id: 'char_469_indigo', full: true },
    "玫兰莎": { q: Q_URL+'char_208_melan.png', a: getAva('','头像_玫兰莎.png'), bg: '', id: '', full: false },
    "令": { q: '', a: '', bg: '', id: 'char_2023_ling', full: true },
    // 黑冠特蕾西娅：头像走外站 npc_1296（avatar/npc_1296_tersia.png，外站无其 portrait）；
    //  胸像走自备 Avg_avg_npc_1296_1-1$1.png（主分支）。两者固定，不随晋升切换。
    //  注：前端仅保留「魔王」与「黑冠特蕾西娅」两版；原名「特蕾西娅」已移除（干扰项，不参与任何映射）。
    "黑冠特蕾西娅": { q: Q_URL+'Avg_avg_npc_1296_1-1$1.png', avaId: 'npc_1296_tersia', bg: '', id: '', full: false },
    // 魔王：独立角色（与「黑冠特蕾西娅」分开计算、条目单列；头像不共用特蕾西娅）。
    //  外站无独立魔王素材 → 头像暂用图池里的魔王立绘；胸像留空。
    "魔王": { q: '', a: 'https://cb.wss.moe/d3et3u.webp', bg: '', id: '', full: false },
    // ── 新增（id 由 arknights_avatars/avatars_out/index.csv 查得，走 gcore 外站图链）──
    "星源": { q: '', a: '', bg: '', id: 'char_135_halo', full: true },
    "夜魔": { q: '', a: '', bg: '', id: 'char_164_nightm', full: true },
    "流明": { q: '', a: '', bg: '', id: 'char_4042_lumen', full: true },
    "亚叶": { q: '', a: '', bg: '', id: 'char_345_folnic', full: true },
    "空弦": { q: '', a: '', bg: '', id: 'char_332_archet', full: true },
    "杰西卡": { q: '', a: '', bg: '', id: 'char_235_jesica', full: true },
    "星极": { q: '', a: '', bg: '', id: 'char_274_astesi', full: true },
    "松桐": { q: '', a: '', bg: '', id: 'char_4199_makiri', full: true },
    "遥": { q: '', a: '', bg: '', id: 'char_4202_haruka', full: true },
    "锡兰": { q: '', a: '', bg: '', id: 'char_348_ceylon', full: true },
    "豆苗": { q: '', a: '', bg: '', id: 'char_452_bstalk', full: true },
    "莱伊": { q: '', a: '', bg: '', id: 'char_4117_ray', full: true },
    "巫恋": { q: '', a: '', bg: '', id: 'char_254_vodfox', full: true },
    "林雨霞": { q: '', a: '', bg: '', id: 'char_4080_lin', full: true },
    "海沫": { q: '', a: '', bg: '', id: 'char_4066_highmo', full: true },
    "黑键": { q: '', a: '', bg: '', id: 'char_4046_ebnhlz', full: true },
    "德克萨斯": { q: '', a: '', bg: '', id: 'char_102_texas', full: true },
    "艾雅法拉": { q: '', a: '', bg: '', id: 'char_180_amgoat', full: true },
    "提丰": { q: '', a: '', bg: '', id: 'char_2012_typhon', full: true },
    "森蚺": { q: '', a: '', bg: '', id: 'char_416_zumama', full: true },
    "天火": { q: '', a: '', bg: '', id: 'char_166_skfire', full: true },
    "银灰": { q: '', a: '', bg: '', id: 'char_172_svrash', full: true },
    "水月": { q: '', a: '', bg: '', id: 'char_437_mizuki', full: true },
    "拉普兰德": { q: '', a: '', bg: '', id: 'char_140_whitew', full: true },
    "煌": { q: '', a: '', bg: '', id: 'char_017_huang', full: true },
    "玛恩纳": { q: '', a: '', bg: '', id: 'char_4064_mlynar', full: true },
    "送葬人": { q: '', a: '', bg: '', id: 'char_279_excu', full: true },
    "傀影": { q: '', a: '', bg: '', id: 'char_250_phatom', full: true },
    "苇草": { q: '', a: '', bg: '', id: 'char_1020_reed2', full: true },
    "乌尔比安": { q: '', a: '', bg: '', id: 'char_4145_ulpia', full: true },
    "余": { q: '', a: '', bg: '', id: 'char_2026_yu', full: true },
    "逻各斯": { q: '', a: '', bg: '', id: 'char_4133_logos', full: true },
    // 无官图三人：走用户自备仓库主分支（q=胸像, a=头像, 固定不随晋升切换）
    "蔓德拉": { q: Q_URL+'Avg_avg_npc_233_1-1 (1).png', a: Q_URL+'Avg_avg_npc_233_1-1 (1)(1).png', bg: '', id: '', full: false },
    "安多恩": { q: Q_URL+'Avg_avg_npc_351_1-1$1.png', a: Q_URL+'Avg_avg_npc_351_1-1$1(1).png', bg: '', id: '', full: false },
    "白垩": { q: Q_URL+'Avg_avg_npc_482_1-1$1.png', a: Q_URL+'Avg_avg_npc_482_1-1$1(1).png', bg: '', id: '', full: false },
    "default": { q: Q_URL+'char_002_amiya.png', a: getAva('','头像_阿米娅(寰宇独奏).png'), bg: '', id: 'char_002_amiya', full: true }
  };
  const getOp = (name) => OperatorDB[name] || OperatorDB['default'];
  // 统一命名：终曲阿米娅为唯一键（图池键同为「终曲阿米娅」）；不再保留旧写法别名。

  // ── 别称统一表：别称 → OperatorDB 标准键 ──────────────────────────────────
  //   玩家/AI/旧档可能写这些别称（阿尔图罗＝塑心的旧称呼、新约能天使＝能天使异格）。
  //   全部登记为同一份图链的同键引用，getOp 即可命中 —— 否则头像/立绘会落回
  //   default（普通阿米娅）造成错位（玩家反馈"阿尔图罗头像失败"即此根因）。
  //   ⚠ 寒灾霜星 / 魔王 不在本表：它们与「霜星」「黑冠特蕾西娅」是**不同角色**，各自独立条目。
  const OP_ALIAS = {
    '阿尔图罗': '塑心',
    '新约能天使': '能天使',
    'Mon3tr': 'mon3tr',   // 大小写变体（官方写作 Mon3tr，全池统一键名 mon3tr）
    'm3': 'mon3tr',       // 图池目录名/旧写法
  };
  Object.keys(OP_ALIAS).forEach((a) => { OperatorDB[a] = OperatorDB[OP_ALIAS[a]]; });

  // ---- 肉鸽立绘图链（立绘同台用；自动生成自 tools/肉鸽立绘_上传.js --upload，勿手改）----
  //   键: <纯干员名> → <年龄档 -1|0|1> → <阶段 a|b|c>，值为 cb.wss.moe 加速链接。
  //   年龄档: -1=10~15岁, 0=16~28岁, 1=29+；阶段: a=敌方库, b=侵蚀, c=活化。
  //   缺失档位由 _portraitUrlFor 回退（-1/1 → 0，b/c → a；整角无图 → 不显示）。
  const ROUGE_PORTRAIT_CHART = {
    "白金": { "0": { "a": "https://cb.wss.moe/whdruq.webp", "b": "https://cb.wss.moe/pyow0w.webp", "c": "https://cb.wss.moe/h83hbk.webp" } },
    "白面鸮": {
      "0": { "a": "https://cb.wss.moe/s89762.webp", "b": "https://cb.wss.moe/4sjyz5.webp", "c": "https://cb.wss.moe/tp1frs.webp" },
      "1": { "a": "https://cb.wss.moe/mn4tsa.webp", "b": "https://cb.wss.moe/jhg9y7.webp", "c": "https://cb.wss.moe/dnky63.webp" }
    },
    "初雪": { "0": { "a": "https://cb.wss.moe/4g0twq.webp", "b": "https://cb.wss.moe/ia880q.webp", "c": "https://cb.wss.moe/2zpqda.webp" } },
    "豆苗": { "0": { "a": "https://cb.wss.moe/638cav.webp", "b": "https://cb.wss.moe/5o88ei.webp", "c": "https://cb.wss.moe/ebpwcx.webp" } },
    "风笛": { "0": { "a": "https://cb.wss.moe/sj1pvw.webp", "b": "https://cb.wss.moe/1fm81q.webp", "c": "https://cb.wss.moe/154n7e.webp" } },
    "芙兰卡": { "0": { "a": "https://cb.wss.moe/7gn0b3.webp", "b": "https://cb.wss.moe/49o94k.webp", "c": "https://cb.wss.moe/5zqq1j.webp" } },
    "海沫": { "0": { "a": "https://cb.wss.moe/k4z9px.webp", "b": "https://cb.wss.moe/b10r83.webp", "c": "https://cb.wss.moe/pwwhc1.webp" } },
    "鸿雪": { "0": { "a": "https://cb.wss.moe/pwgb74.webp", "b": "https://cb.wss.moe/7veqby.webp", "c": "https://cb.wss.moe/aal12z.webp" } },
    "杰西卡": { "0": { "a": "https://cb.wss.moe/0xwhhi.webp", "b": "https://cb.wss.moe/k68gdk.webp", "c": "https://cb.wss.moe/6lrqxx.webp" } },
    "惊蛰": { "0": { "a": "https://cb.wss.moe/by8wtn.webp", "b": "https://cb.wss.moe/9jb9si.webp", "c": "https://cb.wss.moe/r2p5xr.webp" } },
    "卡莱莎": { "0": { "a": "https://cb.wss.moe/ipqt79.webp", "b": "https://cb.wss.moe/2a05u6.webp", "c": "https://cb.wss.moe/6ege4v.webp" } },
    "空": { "0": { "a": "https://cb.wss.moe/268kza.webp", "b": "https://cb.wss.moe/uou0jq.webp", "c": "https://cb.wss.moe/vd9yyb.webp" } },
    "空弦": { "0": { "a": "https://cb.wss.moe/8dg2pr.webp", "b": "https://cb.wss.moe/mme1ue.webp", "c": "https://cb.wss.moe/o3vkfg.webp" } },
    "莱伊": { "0": { "a": "https://cb.wss.moe/ahmdgn.webp", "b": "https://cb.wss.moe/3a97dr.webp", "c": "https://cb.wss.moe/uxvs38.webp" } },
    "蓝毒": { "0": { "a": "https://cb.wss.moe/7szeu2.webp", "b": "https://cb.wss.moe/fu8dam.webp", "c": "https://cb.wss.moe/277l0b.webp" } },
    "雷蛇": { "0": { "a": "https://cb.wss.moe/y96cj7.webp", "b": "https://cb.wss.moe/icc6os.webp", "c": "https://cb.wss.moe/gs6cxc.webp" } },
    "林雨霞": { "0": { "a": "https://cb.wss.moe/k2zthu.webp", "b": "https://cb.wss.moe/r4kdsy.webp", "c": "https://cb.wss.moe/agussl.webp" } },
    "铃兰": {
      "-1": { "a": "https://cb.wss.moe/4swrbo.webp", "b": "https://cb.wss.moe/hw1c20.webp", "c": "https://cb.wss.moe/vc56l6.webp" },
      "0": { "a": "https://cb.wss.moe/lfdfeq.webp", "b": "https://cb.wss.moe/de5jrb.webp", "c": "https://cb.wss.moe/aon3ur.webp" },
      "1": { "a": "https://cb.wss.moe/pzjgno.webp", "b": "https://cb.wss.moe/x1ia75.webp", "c": "https://cb.wss.moe/w9cf2p.webp" }
    },
    "玫兰莎": { "0": { "a": "https://cb.wss.moe/wduszu.webp", "b": "https://cb.wss.moe/tkjzqm.webp", "c": "https://cb.wss.moe/2ehymc.webp" } },
    "琴柳": { "0": { "a": "https://cb.wss.moe/z2wz2p.webp", "b": "https://cb.wss.moe/xc2rtj.webp", "c": "https://cb.wss.moe/h5n3c0.webp" } },
    "深靛": { "0": { "a": "https://cb.wss.moe/fzak7d.webp", "b": "https://cb.wss.moe/zlx6nr.webp", "c": "https://cb.wss.moe/ajj7h5.webp" } },
    "狮蝎": { "0": { "a": "https://cb.wss.moe/qkc3p1.webp", "b": "https://cb.wss.moe/uyojax.webp", "c": "https://cb.wss.moe/5a2gk1.webp" } },
    "桃金娘": { "0": { "a": "https://cb.wss.moe/mxh7nu.webp", "b": "https://cb.wss.moe/nit87f.webp", "c": "https://cb.wss.moe/qpzeo8.webp" } },
    "薇薇安娜": {
      "-1": { "a": "https://cb.wss.moe/yu05ch.webp", "b": "https://cb.wss.moe/byhoyb.webp", "c": "https://cb.wss.moe/ymz1ew.webp" },
      "0": { "a": "https://cb.wss.moe/6cx4zo.webp", "b": "https://cb.wss.moe/fi3t7o.webp", "c": "https://cb.wss.moe/j8ktcm.webp" }
    },
    "温蒂": { "0": { "a": "https://cb.wss.moe/e3che8.webp", "b": "https://cb.wss.moe/rmoncu.webp", "c": "https://cb.wss.moe/lvj5su.webp" } },
    "巫恋": {
      "0": { "a": "https://cb.wss.moe/iku4sk.webp", "b": "https://cb.wss.moe/uzy3rc.webp", "c": "https://cb.wss.moe/d3p8j9.webp" },
      "1": { "a": "https://cb.wss.moe/x9b0uu.webp", "b": "https://cb.wss.moe/vtekn4.webp", "c": "https://cb.wss.moe/igng6g.webp" }
    },
    "锡兰": { "0": { "a": "https://cb.wss.moe/nfm5ax.webp", "b": "https://cb.wss.moe/m7oyiz.webp", "c": "https://cb.wss.moe/rvdqws.webp" } },
    "晓歌": { "0": { "a": "https://cb.wss.moe/v0xpmq.webp", "b": "https://cb.wss.moe/dxs8h8.webp", "c": "https://cb.wss.moe/km4osp.webp" } },
    "星极": { "0": { "a": "https://cb.wss.moe/l1z8uh.webp", "b": "https://cb.wss.moe/5gmtux.webp", "c": "https://cb.wss.moe/19hzgj.webp" } },
    "星源": { "0": { "a": "https://cb.wss.moe/w4x3qm.webp", "b": "https://cb.wss.moe/ghylkv.webp", "c": "https://cb.wss.moe/znmi8u.webp" } },
    "絮雨": {
      "-1": { "a": "https://cb.wss.moe/93m6f3.webp", "b": "https://cb.wss.moe/lgg20n.webp", "c": "https://cb.wss.moe/8m2xa9.webp" },
      "0": { "a": "https://cb.wss.moe/xqkfpz.webp", "b": "https://cb.wss.moe/e7zi23.webp", "c": "https://cb.wss.moe/bh29qv.webp" }
    },
    "亚叶": { "0": { "a": "https://cb.wss.moe/e80gdk.webp", "b": "https://cb.wss.moe/dhm6n0.webp", "c": "https://cb.wss.moe/npbjz1.webp" } },
    "遥": { "0": { "a": "https://cb.wss.moe/d1u2ef.webp", "b": "https://cb.wss.moe/uf64vq.webp", "c": "https://cb.wss.moe/0c4sjy.webp" } },
    "夜魔": { "0": { "a": "https://cb.wss.moe/p45rky.webp", "b": "https://cb.wss.moe/79ryfg.webp", "c": "https://cb.wss.moe/pz1xtv.webp" } },
    "夜莺": {
      "-1": { "a": "https://cb.wss.moe/2r9fq4.webp", "b": "https://cb.wss.moe/il5eil.webp", "c": "https://cb.wss.moe/k8iwxy.webp" },
      "0": { "a": "https://cb.wss.moe/yu1qec.webp", "b": "https://cb.wss.moe/3bwsb4.webp", "c": "https://cb.wss.moe/w06m2c.webp" }
    },
    "羽毛笔": { "0": { "a": "https://cb.wss.moe/fq3fk8.webp", "b": "https://cb.wss.moe/wzchbx.webp", "c": "https://cb.wss.moe/fowwbu.webp" } },
    "艾雅法拉": { "0": { "a": "https://cb.wss.moe/5jogit.webp", "b": "https://cb.wss.moe/89w0j8.webp", "c": "https://cb.wss.moe/lcewjk.webp" } },
    "安洁莉娜": { "0": { "a": "https://cb.wss.moe/dy8pmg.webp", "b": "https://cb.wss.moe/bjwc58.webp", "c": "https://cb.wss.moe/iz96eb.webp" } },
    "德克萨斯": { "0": { "a": "https://cb.wss.moe/wb83i2.webp", "b": "https://cb.wss.moe/cjg566.webp", "c": "https://cb.wss.moe/gxj7yp.webp" } },
    "多萝西": { "0": { "a": "https://cb.wss.moe/a3uoa0.webp", "b": "https://cb.wss.moe/1vmtxj.webp", "c": "https://cb.wss.moe/62qutk.webp" } },
    "洁尔佩塔": { "0": { "a": "https://cb.wss.moe/ryfyl6.webp", "b": "https://cb.wss.moe/4kfox8.webp", "c": "https://cb.wss.moe/7x00ox.webp" } },
    "凯尔希": {
      "-1": { "a": "https://cb.wss.moe/7timkd.webp", "b": "https://cb.wss.moe/bg1yrc.webp", "c": "https://cb.wss.moe/ypahf2.webp" },
      "0": { "a": "https://cb.wss.moe/n777j7.webp", "b": "https://cb.wss.moe/p6p5y5.webp", "c": "https://cb.wss.moe/uk74c6.webp" }
    },
    "克莱门莎": { "0": { "a": "https://cb.wss.moe/th32rp.webp", "b": "https://cb.wss.moe/iudxpl.webp", "c": "https://cb.wss.moe/5cylsk.webp" } },
    "莫斯提马": { "0": { "a": "https://cb.wss.moe/bje4rt.webp", "b": "https://cb.wss.moe/zt4l03.webp", "c": "https://cb.wss.moe/s4s8du.webp" } },
    "森蚺": { "0": { "a": "https://cb.wss.moe/poj322.webp", "b": "https://cb.wss.moe/ezy361.webp", "c": "https://cb.wss.moe/au7i99.webp" } },
    "提丰": { "0": { "a": "https://cb.wss.moe/w6z6cf.webp", "b": "https://cb.wss.moe/rcqagq.webp", "c": "https://cb.wss.moe/5tqemy.webp" } },
    "天火": { "0": { "a": "https://cb.wss.moe/5rtac4.webp", "b": "https://cb.wss.moe/yr20pl.webp", "c": "https://cb.wss.moe/4taj49.webp" } },
    "伊内丝": { "0": { "a": "https://cb.wss.moe/g0ura1.webp", "b": "https://cb.wss.moe/zw00gg.webp", "c": "https://cb.wss.moe/11cf4f.webp" } },
    "阿米娅": {
      "0": { "a": "https://cb.wss.moe/mnxkwb.webp", "b": "https://cb.wss.moe/cmvl23.webp", "c": "https://cb.wss.moe/zbvbw3.webp" },
      "1": { "a": "https://cb.wss.moe/ij9s8f.webp", "b": "https://cb.wss.moe/gox6fy.webp", "c": "https://cb.wss.moe/zk6g2q.webp" }
    },
    "斥罪": { "0": { "a": "https://cb.wss.moe/menh1e.webp", "b": "https://cb.wss.moe/0eeybn.webp", "c": "https://cb.wss.moe/040vzn.webp" } },
    "迷迭香": {
      "-1": { "a": "https://cb.wss.moe/fwd4xh.webp", "b": "https://cb.wss.moe/kyh462.webp", "c": "https://cb.wss.moe/o27dw7.webp" },
      "0": { "a": "https://cb.wss.moe/5as4e2.webp", "b": "https://cb.wss.moe/7ke5wz.webp", "c": "https://cb.wss.moe/dafios.webp" },
      "1": { "a": "https://cb.wss.moe/dh1943.webp", "b": "https://cb.wss.moe/0j0wk2.webp", "c": "https://cb.wss.moe/o80avr.webp" }
    },
    "泥岩": { "0": { "a": "https://cb.wss.moe/1og9f3.webp", "b": "https://cb.wss.moe/mk443a.webp", "c": "https://cb.wss.moe/fj6xo8.webp" } },
    "史尔特尔": { "0": { "a": "https://cb.wss.moe/51be1k.webp", "b": "https://cb.wss.moe/y54iij.webp", "c": "https://cb.wss.moe/21z5mc.webp" } },
    "W": { "0": { "a": "https://cb.wss.moe/gi007r.webp", "b": "https://cb.wss.moe/1ep3mz.webp", "c": "https://cb.wss.moe/h0uyth.webp" } },
    "塑心": {
      "-1": { "a": "https://cb.wss.moe/23xl56.webp", "b": "https://cb.wss.moe/kd9q3n.webp", "c": "https://cb.wss.moe/p93rns.webp" },
      "0": { "a": "https://cb.wss.moe/i0mw5v.webp", "b": "https://cb.wss.moe/ynczar.webp", "c": "https://cb.wss.moe/riv40y.webp" }
    },
    "寒灾霜星": {
      "-1": { "a": "https://cb.wss.moe/iaxqbh.webp", "b": "https://cb.wss.moe/l4h7u7.webp", "c": "https://cb.wss.moe/ane0ac.webp" },
      "0": { "a": "https://cb.wss.moe/o1t7ub.webp", "b": "https://cb.wss.moe/bt83k2.webp", "c": "https://cb.wss.moe/bnvr12.webp" }
    },
    "黑": { "0": { "a": "https://cb.wss.moe/m9ib3u.webp", "b": "https://cb.wss.moe/5bxo2j.webp", "c": "https://cb.wss.moe/finoca.webp" } },
    "黑冠特蕾西娅": { "0": { "a": "https://cb.wss.moe/nqo05n.webp", "b": "https://cb.wss.moe/bhg2nj.webp", "c": "https://cb.wss.moe/fk2bb6.webp" } },
    "煌": { "0": { "a": "https://cb.wss.moe/hkeo0f.webp", "b": "https://cb.wss.moe/227xo3.webp", "c": "https://cb.wss.moe/11ue8b.webp" } },
    "颉": { "0": { "a": "https://cb.wss.moe/tbpdwc.webp", "b": "https://cb.wss.moe/ophtl2.webp", "c": "https://cb.wss.moe/34cif1.webp" } },
    "均": { "0": { "a": "https://cb.wss.moe/1dlg9r.webp", "b": "https://cb.wss.moe/f9yl59.webp", "c": "https://cb.wss.moe/b9kxdx.webp" } },
    "拉普兰德": { "0": { "a": "https://cb.wss.moe/jivin1.webp", "b": "https://cb.wss.moe/r79t02.webp", "c": "https://cb.wss.moe/hw5mob.webp" } },
    "菈玛莲": { "0": { "a": "https://cb.wss.moe/2veln6.webp", "b": "https://cb.wss.moe/ih2niy.webp", "c": "https://cb.wss.moe/deqaru.webp" } },
    "蕾缪安": {
      "-1": { "a": "https://cb.wss.moe/k0muzg.webp", "b": "https://cb.wss.moe/npidmj.webp", "c": "https://cb.wss.moe/7yssoj.webp" },
      "0": { "a": "https://cb.wss.moe/0rvpqp.webp", "b": "https://cb.wss.moe/rry6s4.webp", "c": "https://cb.wss.moe/3tg7go.webp" }
    },
    "令": { "0": { "a": "https://cb.wss.moe/8y5utl.webp", "b": "https://cb.wss.moe/pjxi77.webp", "c": "https://cb.wss.moe/9yjcr5.webp" } },
    "蔓德拉": { "0": { "a": "https://cb.wss.moe/d8ab00.webp", "b": "https://cb.wss.moe/xwi1l8.webp", "c": "https://cb.wss.moe/dbp95z.webp" } },
    "魔王": { "0": { "a": "https://cb.wss.moe/d3et3u.webp", "b": "https://cb.wss.moe/iqo7el.webp", "c": "https://cb.wss.moe/umf7ot.webp" } },
    "缪尔赛思": { "0": { "a": "https://cb.wss.moe/tbdn1a.webp", "b": "https://cb.wss.moe/od3d4p.webp", "c": "https://cb.wss.moe/7ovsqh.webp" } },
    "能天使": {
      "-1": { "a": "https://cb.wss.moe/rwad9l.webp", "b": "https://cb.wss.moe/v0odkb.webp", "c": "https://cb.wss.moe/m251wj.webp" },
      "0": { "a": "https://cb.wss.moe/jj55zh.webp", "b": "https://cb.wss.moe/c89v2q.webp", "c": "https://cb.wss.moe/1ppk9g.webp" }
    },
    "普瑞赛斯": { "0": { "a": "https://cb.wss.moe/cfbuht.webp" } },
    "忍冬": { "0": { "a": "https://cb.wss.moe/fvyt2c.webp", "b": "https://cb.wss.moe/w7i2k0.webp", "c": "https://cb.wss.moe/ek3aqr.webp" } },
    "黍": { "0": { "a": "https://cb.wss.moe/p3zzb0.webp", "b": "https://cb.wss.moe/6ydkx1.webp", "c": "https://cb.wss.moe/q7bs52.webp" } },
    "霜星": {
      "-1": { "a": "https://cb.wss.moe/iaxqbh.webp", "b": "https://cb.wss.moe/l4h7u7.webp", "c": "https://cb.wss.moe/ane0ac.webp" },
      "0": { "a": "https://cb.wss.moe/7hh31p.webp", "b": "https://cb.wss.moe/9cufdc.webp", "c": "https://cb.wss.moe/hliirt.webp" }
    },
    "水月": { "0": { "a": "https://cb.wss.moe/uvwndi.webp", "b": "https://cb.wss.moe/p4g1t2.webp", "c": "https://cb.wss.moe/lwojs8.webp" } },
    "斯卡蒂": { "0": { "a": "https://cb.wss.moe/swhb0f.webp", "b": "https://cb.wss.moe/hnaqiy.webp", "c": "https://cb.wss.moe/ld1ue7.webp" } },
    "死芒": { "0": { "a": "https://cb.wss.moe/u6t0l7.webp", "b": "https://cb.wss.moe/h46jp3.webp", "c": "https://cb.wss.moe/3kj6es.webp" } },
    "夕": { "0": { "a": "https://cb.wss.moe/2l77v9.webp", "b": "https://cb.wss.moe/z1gjxq.webp", "c": "https://cb.wss.moe/efcdyl.webp" } },
    "幽灵鲨": { "0": { "a": "https://cb.wss.moe/nhrhc1.webp", "b": "https://cb.wss.moe/yfbimp.webp", "c": "https://cb.wss.moe/6oa4hg.webp" } },
    "浊心斯卡蒂": { "0": { "a": "https://cb.wss.moe/2ge0ch.webp", "b": "https://cb.wss.moe/rihk9d.webp", "c": "https://cb.wss.moe/fuwk28.webp" } },
    "mon3tr": { "0": { "a": "https://cb.wss.moe/pqjugi.webp", "b": "https://cb.wss.moe/6k0311.webp", "c": "https://cb.wss.moe/wqs7kk.webp" } },
    "希尔达": { "0": { "a": "https://cb.wss.moe/tdnt96.webp", "b": "https://cb.wss.moe/rbrmqv.webp", "c": "https://cb.wss.moe/5l8qqf.webp" } },
    "苇草": { "0": { "a": "https://cb.wss.moe/wmcy83.webp", "b": "https://cb.wss.moe/zjwcp8.webp", "c": "https://cb.wss.moe/24i5z1.webp" } },
    "终曲阿米娅": { "0": { "a": "https://cb.wss.moe/tc73ku.webp", "b": "https://cb.wss.moe/3yaznt.webp", "c": "https://cb.wss.moe/w3c5p5.webp" } }
  };
  // 立绘画幅档位名单（大号/小号池）；不在名单内的角色用默认画幅。以后按需增删。
  //   大号：比默认画幅更大（顶到顶边栏下缘）；小号：比默认画幅小 8%（底边不动、从上往下等比缩）。
  const PORTRAIT_LARGE = new Set(['薇薇安娜', '魔王', '菈玛莲']);
  const PORTRAIT_SMALL = new Set(['杰西卡', '空', '巫恋', '晓歌', '亚叶', '遥', '夜魔', 'mon3tr', '缪尔赛思']);

  // ---- 图链解析 ----
  //  ① 文件名字段必须整段编码：外站皮肤名含 `#`（会被当 URL 片段）、自备链含 `$` 与空格，
  //     不编码会静默 404。只编码路径最后一段，目录分隔符保留。
  const encSeg = (url) => String(url || '').replace(/[^/]+$/, (s) => encodeURIComponent(s));
  const encUrl = (u) => (u ? encSeg(u) : u);

  //  ② 胸像档位：侵蚀状态用精一，晋升/活化后用精二。
  const artEliteOf = (op) => {
    const o = op || {};
    if (o.状态 === '侵蚀') return false;              // 侵蚀态一律精一胸像
    return !!(o.已晋升) || o.状态 === '活化';           // 晋升或活化 → 精二胸像
  };
  //  ③ 立绘（胸像）。full=false 或无外站 id 时退回手写链，绝不因晋升而空链。
  const opArt = (name, elite) => {
    const e = getOp(cleanName(name));
    if (e.id && e.full) return encUrl(AK_URL + 'portrait/' + e.id + '_' + (elite ? '2' : '1') + '.png');
    return encUrl(e.q || e.a || '');
  };
  //  ④ 头像（方图）。**优先用无后缀原版**（`<id>.png`，即未晋升头像）——48 个外站角色全都有这张；
  //     没有无后缀时才退 `_2`。头像不随晋升切换（这是刻意的：绝大部分干员头像保持未晋升形态）。
  //     泥岩：原版 `<id>.png` 就是脱盔甲那张，故天然正确，无需特例。
  //     avaId 可整体改走别的 id（如黑冠特蕾西娅走外站 npc_1296 头像）。
  const opAva = (name) => {
    const e = getOp(cleanName(name));
    if (e.avaId) return encUrl(AK_URL + 'avatar/' + e.avaId + '.png');
    if (e.id && e.full) return encUrl(AK_URL + 'avatar/' + e.id + '.png');
    return encUrl(e.a || e.q || '');
  };

  // 从标本键中提取纯干员名（用于查 OperatorDB / 头像 / 立绘图链等数值层）。
  // **标本身份键格式 = 干员名 + 所属时间线的四位编号**（如 `阿米娅1234`）：
  //   它只用于唯一标识"某条世界线上的这一个她"；显示与数值计算一律回退到纯干员名。
  //   同一角色的不同编号 = **不同个体**（异构体），可以同台：阿米娅1234 / 阿米娅5678 / 阿米娅。
  // 旧的 `干员名_两位base36`（如 `霜星_ab`）保留**只读兼容**（历史数据、旧聊天里的名字仍能显示）。
  function cleanName(key) {
    const s = String(key || '');
    if (s.length > 4 && /\d{4}$/.test(s)) return s.slice(0, -4);   // 阿米娅1234 → 阿米娅
    return s.replace(/_[0-9a-z]{2}$/, '');                          // 兼容旧键 霜星_ab → 霜星
  }

  /** 标本键里的四位时间线编号（不是标本键 → ''）。`阿米娅1234` → `1234`。 */
  function specimenTlOf(key) {
    const s = String(key || '');
    if (s.length <= 4) return '';
    const m = /(\d{4})$/.exec(s);
    return m ? m[1] : '';
  }

  /** 是否「标本身份键」（干员名 + 四位时间线编号）。旧 `名_ab` 不算（历史遗留键，另走兼容分支）。 */
  function isSpecimenKey(key) { return !!specimenTlOf(key); }

  // =========================================================================================
  // 【模块2.55：立绘同台 —— 肉鸽立绘图链解析 + 双人舞台引擎】
  //   姓名识别：复用 gal 界面说话人（<角色名> 标签，见 _galApplySpeaker 挂钩）。
  //   年龄档：读「外表年龄」（外貌特征.年龄，缺省回退 年龄），正则包含匹配取数字，
  //           <16 → -1，16..28 → 0，>28 → 1；解析不出 → 0。
  //   阶段：在 敌方库 → a；干员编队/标本库 → 状态==='活化' ? c : b；无记录 → a。
  //   兜底（需求5）：档位缺 -1/1 → 0；阶段缺 b/c → a；整角无图 → 不显示。
  //   复制人（需求4）：key 用说话人原名（如 白金_ab）独立占台，图源经 cleanName 模糊匹配共用「白金」。
  // =========================================================================================

  /** 外表年龄取数（包含匹配：'约300岁'→300，'待发掘'→null）。 */
  function _parseAgeNum(rec) {
    const v = (rec && rec.外貌特征 && rec.外貌特征.年龄) || (rec && rec.年龄) || '';
    const m = String(v).match(/[-+]?\d+/);
    if (!m) return null;
    const n = Number(m[0]);
    return isFinite(n) ? n : null;
  }

  /** 定位角色的档案记录（决定 a/b/c 阶段与年龄档）。
   *  ① **标本身份键**（`阿米娅1234`，含玩家改名后的 `小阿米娅1234`）：
   *     **干员编队精确 → 标本库全库精确**（编队优先 = 她已在本局队伍里，以队伍里那份为准）；
   *     两处都没命中 → 当野生名继续往下走（正文里过期/写歪的标记不至于整张图消失）。
   *  ② **无后缀（野生）**：敌方库 → 干员编队，先精确键、再按纯名 / 角色库真名容错 —— **既有口径不动**。
   *  ⚠ 标本库是两层（编号 → 卡），走 specFindExact；按第一层下标直接取拿到的是"某个时间线组"。 */
  function _findPortraitRecord(vars, nameKey) {
    const k = String(nameKey == null ? '' : nameKey).trim();
    if (!k) return null;
    const bagOf = (bag, key) => {
      const rec = (vars && vars[bag] && vars[bag][key]) || null;
      return (rec && typeof rec === 'object' && !Array.isArray(rec)) ? rec : null;
    };
    if (isSpecimenKey(k)) {
      const inRoster = bagOf('干员编队', k);
      if (inRoster) return { 库: '干员编队', 记录: inRoster };
      const hit = specFindExact(vars, k);
      if (hit) return { 库: '标本库', 记录: hit.rec };
    }
    const cands = [k];
    const cn = cleanName(k);
    if (cn && cn !== k && cands.indexOf(cn) < 0) cands.push(cn);
    const kn = _matchKnownName(k);
    if (kn && cands.indexOf(kn) < 0) cands.push(kn);
    for (let i = 0; i < cands.length; i++) {
      for (let j = 0; j < 2; j++) {
        const bag = j === 0 ? '敌方库' : '干员编队';
        const rec = bagOf(bag, cands[i]);
        if (rec) return { 库: bag, 记录: rec };
      }
    }
    return null;
  }

  /** 取图链某一档（跳过空对象档，用于 -1/1 → 0 回退）。 */
  function _pickPortraitBucket(slot, bucket) {
    const e = slot[bucket];
    return (e && typeof e === 'object' && Object.keys(e).length) ? e : null;
  }

  // ---- 已知角色名表（图链 + 干员池 + 干员库 并集，按长度降序）与最长匹配 --------------------
  // 用途：{空弦_rt} 这类带后缀的指向角色/说话人 → 最长前缀匹配出 "空弦"，防止误配 "空" 等单字；
  //       {凯尔希_大老婆} → "凯尔希"（cleanName 只剥两位编号后缀，剥不了中文后缀，必须走本表）。
  let _portraitNamesCache = null;
  function portraitNames() {
    if (_portraitNamesCache) return _portraitNamesCache;
    const s = new Set();
    Object.keys(ROUGE_PORTRAIT_CHART || {}).forEach((k) => s.add(k));
    Object.keys(OperatorDB || {}).forEach((k) => s.add(k));
    Object.keys(POOL_BY_NAME || {}).forEach((k) => s.add(k));
    _portraitNamesCache = [...s].sort((a, b) => b.length - a.length);
    return _portraitNamesCache;
  }
  /** 只认角色库真名：返回已知角色名中的最长前缀匹配（{空弦_rt}→空弦；{少女}→''）。 */
  function _matchKnownName(name) {
    const c = String(name == null ? '' : name).trim();
    if (!c) return '';
    const list = portraitNames();
    for (let i = 0; i < list.length; i++) {
      if (c === list[i] || c.startsWith(list[i])) return list[i];
    }
    return '';
  }
  /** 名字 → 图源基底名：先最长前缀匹配已知角色名，退而 cleanName 剥掉标本后缀。 */
  function _matchBaseName(name) {
    return _matchKnownName(name) || cleanName(name);
  }

  /**
   * 立绘图链基底名（能查到图链的那一个才算数）：
   *   · `阿米娅1234`      → `_matchKnownName` 前缀匹配出「阿米娅」→ 有图链 ✓
   *   · `小阿米娅1234`    → 前缀匹配不到、`cleanName` 也是「小阿米娅」（图链里没有）
   *                        → 回退她卡上记的 `原名`（改名时写入）=「阿米娅」✓
   *   · 野生角色          → 与改前完全一致（`_matchBaseName` 同口径）。
   * @param {string} nameKey 正文/锚点里的名字（可带四位编号后缀）
   * @param {object} [rec] 她的档案记录（改名过的标本靠它回退原名）
   */
  function _portraitBaseFor(nameKey, rec) {
    const order = [];
    const push = (x) => { const s = String(x == null ? '' : x).trim(); if (s && order.indexOf(s) < 0) order.push(s); };
    push(_matchKnownName(nameKey));
    push(cleanName(nameKey));
    push(rec && rec.原名);
    push(_matchKnownName(rec && rec.原名));
    for (let i = 0; i < order.length; i++) if (_chartSlotFor(order[i])) return order[i];
    return order[0] || '';
  }

  /** 图池取档：精确 → 别称归一（OP_ALIAS → 图池键）→ 反向别称（图池键 → base）→ 大小写兜底。
   *  仅"不同称呼"的别名会命中（塑心→阿尔图罗、新约能天使→能天使、m3/Mon3tr→mon3tr）；
   *  不同世界线的角色（魔王/黑冠特蕾西娅、斯卡蒂/浊心斯卡蒂、霜星/寒灾霜星）没有别名，绝不互查。 */
  function _chartSlotFor(base) {
    const chart = ROUGE_PORTRAIT_CHART || {};
    if (chart[base]) return chart[base];
    const aliasKey = OP_ALIAS[base];
    if (aliasKey && chart[aliasKey]) return chart[aliasKey];
    for (const k of Object.keys(chart)) {
      if (OP_ALIAS[k] === base) return chart[k];
    }
    const low = String(base).toLowerCase();
    const k2 = Object.keys(chart).find((x) => x.toLowerCase() === low);
    return k2 ? chart[k2] : null;
  }

  /** 核心解析：说话人名 → 最终立绘 URL（找不到返回 ''，调用方据此不入台）。
   *  顺序：**先按名字定位记录**（标本键走编队/标本库精确匹配），再用那条记录的年龄与阶段取图 ——
   *  所以同一个人的不同编号（阿米娅1234 / 阿米娅5678）会按各自的档案拿到各自的样子。 */
  function _portraitUrlFor(nameKey, vars) {
    const rec = _findPortraitRecord(vars, nameKey);
    const base = _portraitBaseFor(nameKey, rec && rec.记录);
    const slot = _chartSlotFor(base);
    if (!slot) return '';
    const suffix = rec
      ? (rec.库 === '敌方库' ? 'a' : ((rec.记录 && rec.记录.状态 === '活化') ? 'c' : 'b'))
      : 'a';
    const age = rec ? _parseAgeNum(rec.记录) : null;
    const bucket = age == null ? '0' : (age < 16 ? '-1' : (age <= 28 ? '0' : '1'));
    const e = _pickPortraitBucket(slot, bucket) || _pickPortraitBucket(slot, '0');
    if (!e) return '';
    return e[suffix] || e['a'] || '';
  }

  /**
   * 同台舞台（固定槽位 + 明暗指针）：
   *   · slots[2] 槽位**固定**（ps-a=首名登场、ps-b=次名；单人居中/双人 ps-a 左 ps-b 右），
   *     换人只切明暗、**绝不重排左右**——两角色轮流发言时各自停在原位（用户要求）。
   *   · 名字已在台上 → 只把明暗指到它（其余槽降暗），不动槽位；
   *   · 全新角色 → 填入空槽并点亮；双槽满 → 顶掉**暗位（非当前点亮=较旧）**那位，
   *     新角色入其槽并点亮——不顶较新、不乱序。
   *   · 无图不入台（需求6）；只存内存，不写变量（需求3.1）。
   */
  const PortraitStage = {
    _visible: true,
    slots: [null, null],   // [{key,url,large} | null]；索引 0=ps-a（左），1=ps-b（右）
    litKey: '',            // 当前点亮角色的 key（明暗指针）
    _els: null,

    _getEls(win) {
      if (this._els && this._els.stage && this._els.stage.isConnected) return this._els;
      const d = win.document;
      this._els = {
        stage: d.getElementById('portrait-stage'),
        a: d.getElementById('ps-a'),
        b: d.getElementById('ps-b'),
      };
      return this._els;
    },

    add(nameKey, win) {
      try {
        this.win = win;
        // 新协议：无指向角色（空锚点/`你`/匹配但无图）→ 立绘全暗，等下次出现角色名再点亮
        if (!nameKey || nameKey === '你') { this.litKey = ''; this.render(); return; }
        // 同一角色名 + 不同编号 = 不同个体：key 用**完整名字**占槽，所以 阿米娅1234 / 阿米娅5678
        // 会各占一槽、各出各的图（多胞胎同台）。图源名称与尺寸档按她自己的记录解析。
        const vars = readVars(win);
        const rec = _findPortraitRecord(vars, nameKey);
        const base = _portraitBaseFor(nameKey, rec && rec.记录);
        const url = _portraitUrlFor(nameKey, vars);
        if (!url) { this.litKey = ''; this.render(); return; }   // 没图 → 不入台（需求6）+ 全暗
        const entry = { key: nameKey, url, large: PORTRAIT_LARGE.has(base), small: PORTRAIT_SMALL.has(base) };
        // ① 名字已在台上 → 只切明暗，不动槽位（用户要求：相同姓名标签不做动作，只切明暗）
        const hit = this.slots.findIndex((s) => s && s.key === nameKey);
        if (hit >= 0) {
          this.litKey = nameKey;
          this.render();
          return;
        }
        // ② 有空槽 → 填入并点亮
        const empty = this.slots.findIndex((s) => !s);
        if (empty >= 0) {
          this.slots[empty] = entry;
          this.litKey = nameKey;
          this.render();
          return;
        }
        // ③ 双槽满 → 顶掉暗位（非当前点亮=较旧）那位，新角色入其槽并点亮；不顶较新、不乱序
        const dimIdx = this.slots.findIndex((s) => s && s.key !== this.litKey);
        this.slots[dimIdx >= 0 ? dimIdx : 0] = entry;
        this.litKey = nameKey;
        this.render();
      } catch (e) { /* 立绘层异常不打断 gal 流程 */ }
    },

    setVisible(on) {
      this._visible = !!on;
      this.render();
      // 显隐切换后槽位盒才真正可量 → 补贴一次（隐藏期间量到的 0×0 会退回 CSS 兜底，这里再贴回精确尺寸）
      this.relayout();
    },

    /**
     * 布局重排后**重新贴合**两个槽的图片盒（增稳关键）：
     *   img 的元素盒是进人时按当时的槽位盒量出来写死的 px；视口/密度/对话框一变，
     *   槽位盒就变了，而 onload 早已跑完不会再量 → 立绘会与容器脱节（曾表现为"缩小后不恢复"）。
     *   由 _galLayout → _psLayout 在每次重排末尾调用；量到退化尺寸时 fit 会退回 CSS 兜底，不会焊死。
     */
    relayout() {
      try {
        const win = this.win;
        if (!win || !win.document) return;
        const el = this._getEls(win);
        [el.a, el.b].forEach((slotEl) => {
          if (!slotEl || typeof slotEl._psFit !== 'function') return;
          try { slotEl._psFit(); } catch (e) {}
        });
      } catch (e) {}
    },

    /** 重开窗口时调用：清空舞台全部状态（宿主闭包内单例跨窗口存活，必须重置才能从正文重建）。 */
    reset() {
      this.slots = [null, null];
      this.litKey = '';
      this._visible = true;
      this.win = null;
      this._els = null;
    },

    /**
     * 单槽绘制：**换人时先 removeAttribute('src') 清旧图** —— 新图加载完成前该槽显示透明空位，
     * 绝不残留上一角色画面（曾出现“两个一模一样的星源”：铃兰图加载慢，lit 槽一直显示旧星源）。
     * key 相同则不重写 DOM（幂等）；lit=false 且有人 → 挂 dim 类（减暗20%）。
     */
    _setSlot(slotEl, entry, lit) {
      if (!slotEl) return;
      const img = slotEl.querySelector('img');
      const key = entry ? entry.key : '';
      if (slotEl._psKey !== key) {
        slotEl._psKey = key;
        if (img) {
          img.removeAttribute('src');
          img.onload = null;                       // 换人先摘旧回调
          img.style.width = '';                    // 复位测量（回到 CSS 铺满槽位盒）
          img.style.height = '';
          img.style.objectFit = 'contain';
        }
        if (entry) {
          slotEl.classList.toggle('large', !!entry.large);
          slotEl.classList.toggle('small', !!entry.small);
          if (img) {
            img.src = entry.url;
            // 图片加载完成后：把 img 元素盒精确缩到"实际渲染内容盒"（object-fit:contain 的等效结果）。
            // 效果：① 保持大图（仍由槽位盒 40%×84% 决定，不缩图）；② 内容在槽内水平居中（不偏）；
            //       ③ mask 渐淡只沿内容边缘、四周可见；④ 滤镜变暗只压有颜色像素。
            // ⚠ objectFit 必须用 contain/fill——用 none 会按原始像素绘制并被元素盒裁切（"原像素裁剪"坑）。
            const fit = () => {
              try {
                const box = slotEl.getBoundingClientRect();
                if (!img.naturalWidth || !img.naturalHeight) return;
                // ⚠ 增稳（曾出现"立绘缩成指甲盖且重开窗口也不好"的顽疾）：
                //   槽位盒量到**退化尺寸**说明此刻布局还没稳定（窗口最小化 / 切到别的标签 /
                //   iframe 被父层隐藏 / 正在拖动改尺寸）——这种情况下**绝不把 img 焊成小像素**，
                //   而是清掉 inline 尺寸退回 CSS 兜底（100%×100% + object-fit:contain），
                //   等下一次 _psLayout 触发 relayout() 再重新量。数据一旦写死在 px 里，
                //   即使随后布局恢复正常，img 也不会自己长大，这就是"恢复不了"的根因。
                if (!box || !box.width || !box.height || box.height < 60 || box.width < 30) {
                  img.style.width = '';
                  img.style.height = '';
                  img.style.objectFit = 'contain';
                  return;
                }
                const r = img.naturalWidth / img.naturalHeight;
                let w = box.height * r, h = box.height;
                if (w > box.width) { w = box.width; h = w / r; }
                img.style.width = Math.round(w) + 'px';
                img.style.height = Math.round(h) + 'px';
                img.style.objectFit = 'contain';
              } catch (e) { /* 测量失败保持 CSS 兜底 */ }
            };
            slotEl._psFit = fit;        // 供 relayout() 在每次重排后复量（布局稳定了就把尺寸贴回去）
            if (img.complete && img.naturalWidth > 0) fit();   // 缓存图 load 可能已派发完
            else img.onload = fit;
          }
        }
      }
      slotEl.classList.toggle('on', !!entry);
      slotEl.classList.toggle('dim', !!entry && !lit);
      if (!entry) slotEl._psFit = null;   // 空槽不留复量回调（下一位进来时重新注册）
    },

    render() {
      try {
        const win = this.win;
        if (!win || !win.document) return;
        const el = this._getEls(win);
        if (!el.stage) return;
        const filled = this.slots.filter(Boolean);
        const n = filled.length;
        const show = this._visible && n > 0;
        el.stage.classList.toggle('on', show);
        if (!show) { el.a.classList.remove('on'); el.b.classList.remove('on'); return; }
        el.stage.classList.toggle('single', n === 1);
        el.stage.classList.toggle('dual', n === 2);
        const hasActive = !!this.litKey;                       // 无点亮角色 → 立绘全暗（新协议）
        el.stage.classList.toggle('noactive', !hasActive);
        this._setSlot(el.a, this.slots[0], hasActive && !!(this.slots[0] && this.slots[0].key === this.litKey));
        this._setSlot(el.b, this.slots[1], hasActive && !!(this.slots[1] && this.slots[1].key === this.litKey));
      } catch (e) { /* 同上 */ }
    },

    clear() {
      this.slots = [null, null];
      this.litKey = '';
      this.render();
    },
  };

  // ---- 内置档案文本：部分自然语言展现在前端写死（不读取/拼凑 OperatorDB/变量）。
  // 仅当有该干员档案时用于 简述/口癖 展示；未收录的退回通用简短描述。
  const BUILTIN_PROFILE = {
    '阿米娅': { 简述: '罗德岛公开领袖，温柔而坚定。', 口癖: '「我会为你战斗到最后。」' },
    '凯尔希': { 简述: '睿智又毒舌的医生，仿佛什么都知道。', 口癖: '「别做多余的事。」' },
    '霜星': { 简述: '雪境出身、背负苦难的战士。', 口癖: '「……我不会再被命运摆布。」' },
    '浊心斯卡蒂': { 简述: '自深渊回响而来的猎手。', 口癖: '「……跟我走吧，永远。」' },
    '斯卡蒂': { 简述: '沉默寡言的猎手，战斗本能敏锐。', 口癖: '「……我会保护你。」' },
    '史尔特尔': { 简述: '来路不明的红发剑士，契约缠身。', 口癖: '「还想活下去的话，就少管我。」' },
    '普瑞赛斯': { 简述: '最后的彼端，你的名字。', 口癖: '「你终于……又见到我了吗？」' },
  };


  // =========================================================================================
  // 【模块2.6：节点敌方/偶遇池 + 时间点系统】
  //   进入节点时从对应池随机抽一名干员，并按该干员本人区间随机一个时间点，战报附「遭遇了 xxxx 年的 xx」。
  //   每人年代范围见 PersonEra（1108=主线终点；长生种/其他世界线/if线不受限；早死者封顶）。
  //   池映射：作战/紧急作战→combat，不期而遇/闲暇娱乐→noncombat，
  //          3层险路恶敌→danger3，5层险路恶敌→danger5，隐藏层险路恶敌→dangerHidden。
  //   时间格式：[[start,end],...] 支持多区间（先随机区间，再区间内随机整数年）。
  // =========================================================================================
  // 节点遭遇池 NodePools 已改为由下方 PoolDB 派生（见 rollFromPool 前的定义）：
  //   combat=各层"作战"非boss并集；noncombat=各层"非作战"非boss并集；开局随机池=两者并集（=全部非boss干员）。
  // 节点类型 → 池名
  const poolForType = {
    '作战': 'combat', '紧急作战': 'combat',
    '不期而遇': 'noncombat', '闲暇娱乐': 'noncombat',
    '险路恶敌': null, // 由层数决定
  };

  /**
   * 从指定池抽取：随机一名干员 + 随机一个时间点。
   * 排除已在干员编队（携带）中的干员（精确匹配姓名）。
   *   - 干员编队键 = 纯干员名（如「风笛」）；标本库键 = 编号_干员名（如「风笛r4」）。
   *   - 因此只有「编队里有同名干员」才被排除；「编队里有标本库编号版」不算本人，不影响出场。
   *   - 若过滤后池为空（该池全被携带），回退全池抽取，避免死局/边界。
   * @param {object} win  iframe window（用于读干员编队）
   * @param {string} poolName 池名
   * @returns {{ name: string, year: number, pool: string } | null}
   */
  // =========================================================================================
  // 【干员池 PoolDB】前端决定"哪一层·哪种节点出现谁"，并携带预设面板（量化/痴愚/三轴/反转三轴）。
  //   出现对象由此表随机；数值为预设，进入节点时随 System 报告给 AI，由 AI 写入「敌方库」建档。
  //   前端只在此决定"出现哪个池子"，不直接改写干员/敌方数值。
  //   每条可选带 `性别: '男' | '女' | '非人'`（缺省 '女'）——供开局界面「干员开关」的一键男女筛选；
  //   PoolDB 本身永不被前端改动，只作名单/数值来源（筛网见【模块2.7】）。
  // =========================================================================================
  const PoolDB = {
    1: {
      作战: [
        { name: '桃金娘', quant: 3, folly: 1, axes: [40, 30, 70], rev: [60, 70, 30] },
        { name: '温蒂', quant: 3, folly: 1, axes: [45, 30, 60], rev: [55, 70, 40] },
        { name: '星源', quant: 3, folly: 1, axes: [35, 25, 70], rev: [65, 75, 30], 性别: '女' },
        { name: '夜魔', quant: 3, folly: 2, axes: [35, 35, 70], rev: [65, 65, 30], 性别: '女' },
        { name: '流明', quant: 3, folly: 0, axes: [40, 25, 55], rev: [60, 75, 45], 性别: '男' },
        { name: '白垩', quant: 3, folly: 0, axes: [50, 40, 50], rev: [50, 60, 50], 性别: '男' },
        { name: '亚叶', quant: 3, folly: 1, axes: [40, 70, 40], rev: [60, 30, 60], 性别: '女' },
        { name: '玫兰莎', quant: 4, folly: 0, axes: [45, 55, 50], rev: [55, 45, 50] },
        { name: '深靛', quant: 4, folly: 0, axes: [40, 50, 60], rev: [60, 50, 40] },
        { name: '蓝毒', quant: 4, folly: 1, axes: [75, 15, 40], rev: [25, 85, 60] },
        { name: '空弦', quant: 4, folly: 1, axes: [45, 20, 60], rev: [55, 80, 40], 性别: '女' },
        { name: '杰西卡', quant: 4, folly: 1, axes: [50, 30, 60], rev: [50, 70, 40], 性别: '女' },
        { name: '雷蛇', quant: 4, folly: 2, axes: [60, 35, 65], rev: [40, 65, 35] },
        { name: '琴柳', quant: 4, folly: 2, axes: [65, 35, 60], rev: [35, 65, 40] },
        { name: '晓歌', quant: 4, folly: 0, axes: [65, 45, 40], rev: [35, 55, 60] },
        { name: '星极', quant: 4, folly: 1, axes: [40, 40, 60], rev: [60, 60, 40], 性别: '女' },
        { name: '松桐', quant: 4, folly: 1, axes: [45, 55, 40], rev: [55, 45, 60], 性别: '男' },
      ],
      非作战: [
        { name: '夜莺', quant: 0, folly: 1, axes: [80, 10, 15], rev: [20, 90, 85] },
        { name: '絮雨', quant: 1, folly: 0, axes: [10, 15, 20], rev: [90, 85, 80] },
        { name: '空', quant: 2, folly: 1, axes: [50, 20, 60], rev: [50, 80, 40] },
        { name: '遥', quant: 2, folly: 1, axes: [40, 30, 70], rev: [60, 70, 30], 性别: '女' },
        { name: '锡兰', quant: 2, folly: 1, axes: [45, 25, 65], rev: [55, 75, 35], 性别: '女' },
        { name: '豆苗', quant: 2, folly: 2, axes: [50, 30, 55], rev: [50, 70, 45], 性别: '女' },
        { name: '星源', quant: 3, folly: 1, axes: [35, 25, 70], rev: [65, 75, 30], 性别: '女' },
        { name: '夜魔', quant: 3, folly: 2, axes: [35, 35, 70], rev: [65, 65, 30], 性别: '女' },
        { name: '流明', quant: 3, folly: 0, axes: [40, 25, 55], rev: [60, 75, 45], 性别: '男' },
        { name: '白垩', quant: 3, folly: 0, axes: [50, 40, 50], rev: [50, 60, 50], 性别: '男' },
        { name: '亚叶', quant: 3, folly: 1, axes: [40, 70, 40], rev: [60, 30, 60], 性别: '女' },
        { name: '桃金娘', quant: 3, folly: 1, axes: [40, 30, 70], rev: [60, 70, 30] },
        { name: '卡莱莎', quant: 8, folly: 3, axes: [85, 75, 85], rev: [15, 25, 15] },
      ],
      boss: [],
    },
    2: {
      作战: [
        { name: '芙兰卡', quant: 4, folly: 1, axes: [50, 40, 60], rev: [50, 60, 40] },
        { name: '莱伊', quant: 4, folly: 0, axes: [35, 25, 80], rev: [65, 75, 20], 性别: '女' },
        { name: '巫恋', quant: 4, folly: 1, axes: [40, 60, 50], rev: [60, 40, 50], 性别: '女' },
        { name: '狮蝎', quant: 5, folly: 0, axes: [70, 20, 30], rev: [30, 80, 70] },
        { name: '林雨霞', quant: 5, folly: 1, axes: [55, 60, 50], rev: [45, 40, 50] },
        { name: '羽毛笔', quant: 5, folly: 3, axes: [75, 65, 30], rev: [25, 35, 70] },
        { name: '惊蛰', quant: 5, folly: 2, axes: [50, 30, 70], rev: [50, 70, 30] },
        { name: '海沫', quant: 5, folly: 0, axes: [30, 80, 40], rev: [70, 20, 60], 性别: '女' },
        { name: '鸿雪', quant: 5, folly: 2, axes: [70, 15, 60], rev: [30, 85, 40] },
        { name: '黑键', quant: 5, folly: 1, axes: [55, 45, 50], rev: [45, 55, 50], 性别: '男' },
        { name: '星极', quant: 4, folly: 1, axes: [40, 40, 60], rev: [60, 60, 40], 性别: '女' },
        { name: '晓歌', quant: 4, folly: 0, axes: [65, 45, 40], rev: [35, 55, 60] },
        { name: '琴柳', quant: 4, folly: 2, axes: [65, 35, 60], rev: [35, 65, 40] },
        { name: '杰西卡', quant: 4, folly: 1, axes: [50, 30, 60], rev: [50, 70, 40], 性别: '女' },
        { name: '松桐', quant: 4, folly: 1, axes: [45, 55, 40], rev: [55, 45, 60], 性别: '男' },
      ],
      非作战: [
        { name: '温蒂', quant: 3, folly: 1, axes: [45, 30, 60], rev: [55, 70, 40] },
        { name: '白面鸮', quant: 3, folly: 3, axes: [70, 20, 50], rev: [30, 80, 50] },
        { name: '铃兰', quant: 3, folly: 1, axes: [40, 15, 80], rev: [60, 85, 20] },
        { name: '初雪', quant: 4, folly: 2, axes: [60, 25, 55], rev: [40, 75, 45] },
        { name: '蓝毒', quant: 4, folly: 1, axes: [75, 15, 40], rev: [25, 85, 60] },
        { name: '巫恋', quant: 4, folly: 1, axes: [40, 60, 50], rev: [60, 40, 50], 性别: '女' },
        { name: '玫兰莎', quant: 4, folly: 0, axes: [45, 55, 50], rev: [55, 45, 50] },
        { name: '深靛', quant: 4, folly: 0, axes: [40, 50, 60], rev: [60, 50, 40] },
        { name: '空弦', quant: 4, folly: 1, axes: [45, 20, 60], rev: [55, 80, 40], 性别: '女' },
        { name: '杰西卡', quant: 4, folly: 1, axes: [50, 30, 60], rev: [50, 70, 40], 性别: '女' },
        { name: '星极', quant: 4, folly: 1, axes: [40, 40, 60], rev: [60, 60, 40], 性别: '女' },
        { name: '雷蛇', quant: 4, folly: 2, axes: [60, 35, 65], rev: [40, 65, 35] },
        { name: '松桐', quant: 4, folly: 1, axes: [45, 55, 40], rev: [55, 45, 60], 性别: '男' },
        { name: '卡莱莎', quant: 8, folly: 3, axes: [85, 75, 85], rev: [15, 25, 15] },
      ],
      boss: [],
    },
    3: {
      作战: [
        { name: '白金', quant: 6, folly: 1, axes: [45, 55, 60], rev: [55, 45, 40] },
        { name: '风笛', quant: 6, folly: 1, axes: [60, 50, 70], rev: [40, 50, 30] },
        { name: '德克萨斯', quant: 6, folly: 1, axes: [50, 30, 70], rev: [50, 70, 30], 性别: '女' },
        { name: '艾雅法拉', quant: 6, folly: 0, axes: [55, 20, 75], rev: [45, 80, 25], 性别: '女' },
        { name: '提丰', quant: 6, folly: 0, axes: [45, 30, 75], rev: [55, 70, 25], 性别: '女' },
        { name: '森蚺', quant: 6, folly: 1, axes: [35, 25, 80], rev: [65, 75, 20], 性别: '女' },
        { name: '天火', quant: 6, folly: 1, axes: [45, 30, 70], rev: [55, 70, 30], 性别: '女' },
        { name: '银灰', quant: 6, folly: 1, axes: [55, 35, 65], rev: [45, 65, 35], 性别: '男' },
        { name: '水月', quant: 6, folly: 1, axes: [40, 50, 60], rev: [60, 50, 40], 性别: '男' },
        { name: '安洁莉娜', quant: 6, folly: 1, axes: [55, 30, 75], rev: [45, 70, 25] },
        { name: '伊内丝', quant: 6, folly: 3, axes: [65, 30, 60], rev: [35, 70, 40] },
        { name: '惊蛰', quant: 5, folly: 2, axes: [50, 30, 70], rev: [50, 70, 30] },
        { name: '海沫', quant: 5, folly: 0, axes: [30, 80, 40], rev: [70, 20, 60], 性别: '女' },
        { name: '鸿雪', quant: 5, folly: 2, axes: [70, 15, 60], rev: [30, 85, 40] },
        { name: '黑键', quant: 5, folly: 1, axes: [55, 45, 50], rev: [45, 55, 50], 性别: '男' },
      ],
      非作战: [
        { name: '莱伊', quant: 4, folly: 0, axes: [35, 25, 80], rev: [65, 75, 20], 性别: '女' },
        { name: '琴柳', quant: 4, folly: 2, axes: [65, 35, 60], rev: [35, 65, 40] },
        { name: '晓歌', quant: 4, folly: 0, axes: [65, 45, 40], rev: [35, 55, 60] },
        { name: '芙兰卡', quant: 4, folly: 1, axes: [50, 40, 60], rev: [50, 60, 40] },
        { name: '狮蝎', quant: 5, folly: 0, axes: [70, 20, 30], rev: [30, 80, 70] },
        { name: '林雨霞', quant: 5, folly: 1, axes: [55, 60, 50], rev: [45, 40, 50] },
        { name: '羽毛笔', quant: 5, folly: 3, axes: [75, 65, 30], rev: [25, 35, 70] },
        { name: '鸿雪', quant: 5, folly: 2, axes: [70, 15, 60], rev: [30, 85, 40] },
        { name: '多萝西', quant: 5, folly: 3, axes: [55, 25, 65], rev: [45, 75, 35] },
        { name: '安洁莉娜', quant: 6, folly: 1, axes: [55, 30, 75], rev: [45, 70, 25] },
        { name: '黑键', quant: 5, folly: 1, axes: [55, 45, 50], rev: [45, 55, 50], 性别: '男' },
        { name: '洁尔佩塔', quant: 10, folly: 2, axes: [90, 15, 80], rev: [10, 85, 20] },
        { name: '卡莱莎', quant: 8, folly: 3, axes: [85, 75, 85], rev: [15, 25, 15] },
      ],
      boss: [
        { name: '凯尔希', quant: 7, folly: 4, axes: [90, 40, 60], rev: [10, 60, 40] },
        { name: '克莱门莎', quant: 6, folly: 3, axes: [70, 35, 75], rev: [30, 65, 25] },
        { name: '莫斯提马', quant: 7, folly: 3, axes: [60, 20, 80], rev: [40, 80, 20] },
        // 普通霜星：正史形态，按史实早夭（PersonEra 封顶 1097）；if 线「寒灾霜星」在 hiddenBoss
        { name: '霜星', quant: 8, folly: 1, axes: [65, 40, 15], rev: [35, 60, 85] },
      ],
    },
    4: {
      作战: [
        { name: '史尔特尔', quant: 6, folly: 1, axes: [20, 40, 80], rev: [80, 60, 20] },
        { name: 'W', quant: 6, folly: 2, axes: [75, 45, 50], rev: [25, 55, 50] },
        { name: '斥罪', quant: 6, folly: 2, axes: [70, 25, 65], rev: [30, 75, 35] },
        { name: '泥岩', quant: 7, folly: 1, axes: [65, 45, 60], rev: [35, 55, 40] },
        { name: '迷迭香', quant: 7, folly: 0, axes: [25, 55, 60], rev: [75, 45, 40] },
        { name: '阿米娅', quant: 7, folly: 4, axes: [45, 40, 85], rev: [55, 60, 15] },
        { name: '拉普兰德', quant: 7, folly: 2, axes: [70, 20, 60], rev: [30, 80, 40], 性别: '女' },
        { name: '蔓德拉', quant: 7, folly: 2, axes: [40, 75, 35], rev: [60, 25, 65], 性别: '女' },
        { name: '能天使', quant: 7, folly: 1, axes: [60, 30, 70], rev: [40, 70, 30] },
        { name: '蕾缪安', quant: 7, folly: 3, axes: [75, 40, 55], rev: [25, 60, 45] },
        { name: '煌', quant: 7, folly: 1, axes: [60, 25, 65], rev: [40, 75, 35], 性别: '女' },
        { name: '伊内丝', quant: 6, folly: 3, axes: [65, 30, 60], rev: [35, 70, 40] },
        { name: '天火', quant: 6, folly: 1, axes: [45, 30, 70], rev: [55, 70, 30], 性别: '女' },
        { name: '银灰', quant: 6, folly: 1, axes: [55, 35, 65], rev: [45, 65, 35], 性别: '男' },
        { name: '水月', quant: 6, folly: 1, axes: [40, 50, 60], rev: [60, 50, 40], 性别: '男' },
        { name: '玛恩纳', quant: 7, folly: 1, axes: [55, 45, 60], rev: [45, 55, 40], 性别: '男' },
      ],
      非作战: [
        { name: '惊蛰', quant: 5, folly: 2, axes: [50, 30, 70], rev: [50, 70, 30] },
        { name: '海沫', quant: 5, folly: 0, axes: [30, 80, 40], rev: [70, 20, 60], 性别: '女' },
        { name: '缪尔赛思', quant: 6, folly: 3, axes: [60, 20, 75], rev: [40, 80, 25] },
        { name: '薇薇安娜', quant: 6, folly: 1, axes: [65, 25, 70], rev: [35, 75, 30] },
        { name: '德克萨斯', quant: 6, folly: 1, axes: [50, 30, 70], rev: [50, 70, 30], 性别: '女' },
        { name: '白金', quant: 6, folly: 1, axes: [45, 55, 60], rev: [55, 45, 40] },
        { name: '风笛', quant: 6, folly: 1, axes: [60, 50, 70], rev: [40, 50, 30] },
        { name: '伊内丝', quant: 6, folly: 3, axes: [65, 30, 60], rev: [35, 70, 40] },
        { name: '斥罪', quant: 6, folly: 2, axes: [70, 25, 65], rev: [30, 75, 35] },
        { name: '苇草', quant: 7, folly: 1, axes: [60, 25, 70], rev: [40, 75, 30] },
        { name: 'W', quant: 6, folly: 2, axes: [75, 45, 50], rev: [25, 55, 50] },
        { name: '玛恩纳', quant: 7, folly: 1, axes: [55, 45, 60], rev: [45, 55, 40], 性别: '男' },
        { name: '傀影', quant: 7, folly: 1, axes: [60, 40, 55], rev: [40, 60, 45], 性别: '男' },
        { name: '洁尔佩塔', quant: 10, folly: 2, axes: [90, 15, 80], rev: [10, 85, 20] },
        { name: '卡莱莎', quant: 8, folly: 3, axes: [85, 75, 85], rev: [15, 25, 15] },
      ],
      boss: [],
    },
    5: {
      作战: [
        { name: '安多恩', quant: 7, folly: 1, axes: [45, 40, 60], rev: [55, 60, 40], 性别: '男' },
        { name: '送葬人', quant: 7, folly: 0, axes: [50, 30, 65], rev: [50, 70, 35], 性别: '男' },
        { name: '傀影', quant: 7, folly: 1, axes: [60, 40, 55], rev: [40, 60, 45], 性别: '男' },
        { name: '幽灵鲨', quant: 7, folly: 1, axes: [80, 35, 65], rev: [20, 65, 35] },
        { name: '斯卡蒂', quant: 7, folly: 1, axes: [85, 40, 60], rev: [15, 60, 40] },
        { name: '塑心', quant: 7, folly: 3, axes: [65, 10, 80], rev: [35, 90, 20] },
        { name: '苇草', quant: 7, folly: 1, axes: [60, 25, 70], rev: [40, 75, 30] },
        { name: '忍冬', quant: 7, folly: 2, axes: [75, 20, 65], rev: [25, 80, 35] },
        { name: 'mon3tr', quant: 7, folly: 4, axes: [85, 35, 60], rev: [15, 65, 40], 性别: '女' },
        { name: '死芒', quant: 8, folly: 2, axes: [95, 30, 50], rev: [5, 70, 50] },
        { name: '乌尔比安', quant: 8, folly: 1, axes: [70, 35, 55], rev: [30, 65, 45], 性别: '男' },
        { name: '泥岩', quant: 7, folly: 1, axes: [65, 45, 60], rev: [35, 55, 40] },
        { name: '迷迭香', quant: 7, folly: 0, axes: [25, 55, 60], rev: [75, 45, 40] },
        { name: '阿米娅', quant: 7, folly: 4, axes: [45, 40, 85], rev: [55, 60, 15] },
        { name: '玛恩纳', quant: 7, folly: 1, axes: [55, 45, 60], rev: [45, 55, 40], 性别: '男' },
      ],
      非作战: [
        { name: '能天使', quant: 7, folly: 1, axes: [60, 30, 70], rev: [40, 70, 30] },
        { name: '塑心', quant: 7, folly: 3, axes: [65, 10, 80], rev: [35, 90, 20] },
        { name: '天火', quant: 6, folly: 1, axes: [45, 30, 70], rev: [55, 70, 30], 性别: '女' },
        { name: '艾雅法拉', quant: 6, folly: 0, axes: [55, 20, 75], rev: [45, 80, 25], 性别: '女' },
        { name: '提丰', quant: 6, folly: 0, axes: [45, 30, 75], rev: [55, 70, 25], 性别: '女' },
        { name: '森蚺', quant: 6, folly: 1, axes: [35, 25, 80], rev: [65, 75, 20], 性别: '女' },
        { name: '水月', quant: 6, folly: 1, axes: [40, 50, 60], rev: [60, 50, 40], 性别: '男' },
        { name: '银灰', quant: 6, folly: 1, axes: [55, 35, 65], rev: [45, 65, 35], 性别: '男' },
        { name: '乌尔比安', quant: 8, folly: 1, axes: [70, 35, 55], rev: [30, 65, 45], 性别: '男' },
        { name: '安多恩', quant: 7, folly: 1, axes: [45, 40, 60], rev: [55, 60, 40], 性别: '男' },
        { name: '送葬人', quant: 7, folly: 0, axes: [50, 30, 65], rev: [50, 70, 35], 性别: '男' },
        { name: '苇草', quant: 7, folly: 1, axes: [60, 25, 70], rev: [40, 75, 30] },
        { name: '缪尔赛思', quant: 6, folly: 3, axes: [60, 20, 75], rev: [40, 80, 25] },
        { name: '洁尔佩塔', quant: 10, folly: 2, axes: [90, 15, 80], rev: [10, 85, 20] },
        { name: '卡莱莎', quant: 8, folly: 3, axes: [85, 75, 85], rev: [15, 25, 15] },
      ],
      boss: [
        { name: '魔王', quant: 9, folly: 3, axes: [95, 10, 10], rev: [5, 90, 90] },
        { name: '菈玛莲', quant: 9, folly: 2, axes: [75, 15, 80], rev: [25, 85, 20] },
        { name: '令', quant: 9, folly: 4, axes: [85, 20, 75], rev: [15, 80, 25] },
        { name: '均', quant: 9, folly: 4, axes: [80, 60, 70], rev: [20, 40, 30] },
        { name: '黍', quant: 9, folly: 4, axes: [75, 30, 80], rev: [25, 70, 20] },
        { name: '夕', quant: 9, folly: 3, axes: [60, 10, 90], rev: [40, 90, 10] },
        { name: '余', quant: 9, folly: 3, axes: [50, 30, 80], rev: [50, 70, 20], 性别: '男' },
        { name: '逻各斯', quant: 9, folly: 3, axes: [85, 20, 75], rev: [15, 80, 25], 性别: '男' },
      ],
    },
    hiddenBoss: [
      { name: '普瑞赛斯', quant: 11, folly: 5, axes: [99, 99, 99], rev: [1, 1, 1] },
      { name: '黑冠特蕾西娅', quant: 10, folly: 4, axes: [90, 25, 85], rev: [10, 75, 15] },
      { name: '终曲阿米娅', quant: 10, folly: 3, axes: [85, 15, 90], rev: [15, 85, 10] },
      { name: '寒灾霜星', quant: 9, folly: 2, axes: [90, 25, 30], rev: [10, 75, 70] },
      { name: '浊心斯卡蒂', quant: 10, folly: 1, axes: [10, 80, 90], rev: [90, 20, 10] },
      { name: '希尔达', quant: 10, folly: 2, axes: [70, 10, 60], rev: [30, 90, 40] },
    ],
  };

  // 名字 → PoolDB 预设 快速查表（用于开局/选中/固定boss时把真实数值填入变量）
  //   ⚠ 必须含 boss 池：否则「凯尔希 / 克莱门莎 / 莫斯提马 / 魔王 / 菈玛莲 / 令 / 均 / 黍 / 夕」
  //     这几位只存在于 PoolDB[层].boss 的干员查不到预设，固定 boss 就会静默退化成随机池。
  //   本表只做"按名查表"，从不被遍历，因此多收录 boss 不会把 boss 混进任何随机池。
  // 派生表统一在 rebuildAllDerived() 内构建（含【创意工坊】自定义池合入后的重建），此处仅声明。
  let POOL_BY_NAME = {};

  // =====================================================================================
  // 【每人年代随机范围表 PersonEra】进入节点时按遭遇角色查表掷年代（唯一随机点 = _enterNode）。
  //   时间格式：[[start,end],...] 支持多区间（先随机区间，再区间内随机整数年，含端点）。
  //   口径：1108 = 主线终点（常规角色上界封 1108）；长生种/其他世界线/if线不受限（上界可远超 1108）；
  //   早死角色按史实封顶（霜星 1097）；「魔王」为独立角色，与「黑冠特蕾西娅」分开计算，区间照旧。
  //   正式名与各池统一（林雨霞 / 苇草 / 终曲阿米娅 / 魔王 / 黑冠特蕾西娅 …），不再保留旧写法。
  // =====================================================================================
  const PersonEra = {
    // ── 作战池 ──────────────────────────────────────────────────────
    '玫兰莎': [[1096, 1108]], '深靛': [[1096, 1108]], '桃金娘': [[1094, 1108]],
    '白金': [[1090, 1108]], '芙兰卡': [[1086, 1108]], '雷蛇': [[1086, 1108]],
    '晓歌': [[1094, 1108]], '狮蝎': [[1088, 1108]], '泥岩': [[1085, 1108]],
    '风笛': [[1086, 1108]], '惊蛰': [[1078, 1108]], '琴柳': [[1094, 1108]],
    '史尔特尔': [[1084, 1108]], 'W': [[1088, 1108]], '伊内丝': [[1078, 1108]],
    '斥罪': [[1082, 1108]], '能天使': [[1086, 1108]], '蕾缪安': [[1084, 1108]],
    '幽灵鲨': [[1080, 1108]], '斯卡蒂': [[1080, 1108]], '塑心': [[1085, 1108]],
    '安洁莉娜': [[1096, 1108]], '温蒂': [[1087, 1108]], '羽毛笔': [[1095, 1108]],
    '死芒': [[1084, 1108]], '迷迭香': [[1094, 1108]], '阿米娅': [[1096, 1108]],
    // ── 新增(按新基准) ────────────────────────────────────────────────
    '空弦': [[1096, 1108]], '德克萨斯': [[1088, 1108]], '拉普兰德': [[1088, 1108]],
    '蔓德拉': [[1092, 1098]], '艾雅法拉': [[1096, 1108]], '海沫': [[1094, 1108]],
    '提丰': [[1096, 1108]], '森蚺': [[1096, 1108]], '黑键': [[1094, 1108]],
    '煌': [[1086, 1108]], '天火': [[1096, 1108]], '玛恩纳': [[1080, 1108]],
    '安多恩': [[1091, 1108]], '送葬人': [[1096, 1108]], '银灰': [[1082, 1108]],
    '傀影': [[1090, 1108]], '水月': [[1097, 1108], [1296, 2325]], '乌尔比安': [[1076, 1108]],
    '杰西卡': [[1096, 1108]], '星极': [[1094, 1108]], '莱伊': [[1096, 1108]], '松桐': [[1094, 1108]],
    // ── 非作战池 ─────────────────────────────────────────────────────
    '夜莺': [[1086, 1108]], '空': [[1090, 1108]], '絮雨': [[1067, 1108]],
    '林雨霞': [[1090, 1108]], '初雪': [[1088, 1108]], '蓝毒': [[1095, 1108]],
    '白面鸮': [[1088, 1108]], '多萝西': [[1086, 1108]], '铃兰': [[1097, 1108]],
    '苇草': [[1088, 1108]], '忍冬': [[1088, 1108]], '鸿雪': [[1090, 1108]],
    '薇薇安娜': [[1092, 1108]], '洁尔佩塔': [[1333, 1333]], '缪尔赛思': [[1085, 1108]],
    'mon3tr': [[1101, 1108]], '卡莱莎': [[898, 1093], [1094, 1108]],
    // ── 新增(按新基准) ────────────────────────────────────────────────
    '遥': [[1096, 1108]], '星源': [[1094, 1108]], '锡兰': [[1096, 1108]], '豆苗': [[1094, 1108]],
    '夜魔': [[1093, 1108]], '流明': [[1098, 1108]], '白垩': [[1094, 1099]],
    '巫恋': [[1096, 1108]], '亚叶': [[1094, 1108]],
    // ── boss 池 ─────────────────────────────────────────────────────
    '凯尔希': [[-10000, -5700], [15, 16], [896, 898], [1031, 1090], [1091, 1108]], '克莱门莎': [[1084, 1108]], '莫斯提马': [[1089, 1108]],
    '魔王': [[898, 1093], [1094, 1108]], '菈玛莲': [[898, 1093], [1094, 1108]],
    '令': [[-1000, 1096], [1097, 1108]], '均': [[-1000, 1096], [1097, 1108]],
    '黍': [[-1000, 1101], [1102, 1108]], '夕': [[-1000, 1096], [1097, 1108]],
    // ── 新增(按新基准) ────────────────────────────────────────────────
    '余': [[-6000, 1099], [1100, 1108]], '逻各斯': [[1086, 1108]],
    // ── 隐藏层（其他世界线 / if线，上界不受 1108 限制）─────────────────
    '普瑞赛斯': [[54878489293, 98238929823982]],
    '黑冠特蕾西娅': [[898, 1093], [1094, 1108]],
    '终曲阿米娅': [[1109, 98238529823982]],
    '寒灾霜星': [[1084, 1108]],
    '浊心斯卡蒂': [[1098, 1108]],
    '希尔达': [[1098, 1108]],
    // 正史霜星：第3层 boss（现役），按史实早死封顶 1097；隐藏层 if 线用独立键 寒灾霜星（上界 1108）。
    '霜星': [[1084, 1097]],
  };
  /** 年代解析别名：统一命名后不再保留旧写法（少用别名）；此处留空备用。 */
  const ERA_ALIAS = {};
  /** 按名取年代区间：先别名归一，再剥标本后缀，查不到回退统一默认。 */
  function eraRanges(name) {
    const raw = String(name == null ? '' : name);
    const key = ERA_ALIAS[raw] || raw;
    return PersonEra[key] || PersonEra[cleanName(raw)] || [[1094, 1108]];
  }
  /** 从该角色区间掷一个整数年（先随机区间，再区间内随机年，含端点）。 */
  function rollPersonYear(name) {
    const ranges = eraRanges(name);
    const range = ranges[Math.floor(Math.random() * ranges.length)];
    return range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
  }

  /**
   * 【少年时代修正】非长生种的少年时代更弱（作者拍板 · 长期写入变量）：
   *   · 触发：当年份所在「年代区间」的跨度（含端点）为 19~29 年（>18 且 <30）；
   *   · 效果：距区间末尾 ≥20 年 → 量化/痴愚 −2、三轴 −10；
   *           距区间末尾 ≥15 年 → 量化/痴愚 −1、三轴 −10；
   *   · 下限：各项不低于 0。
   *   · 返回【浅拷贝】的修正后预设；未触发时原样返回 —— 绝不改写 PoolDB 本体。
   *   持久化口径：修正后的预设随 $切片.$nodeData 长期落变量，并随 System 报告交 AI 建「敌方库」卡；
   *   节点内所有读数路径（叠加面板/敌方雷达/对局导向/战报）只读这份已修正预设，原设回填不再覆盖。
   */
  function applyYouthWeakness(preset, name, year) {
    const raw = String(name == null ? '' : name);
    const key = ERA_ALIAS[raw] || raw;
    const ranges = PersonEra[key] || PersonEra[cleanName(raw)] || [[1094, 1108]];
    const span = ranges.find((r) => year >= r[0] && year <= r[1]);
    if (!span) return preset;                       // 年份不在任何区间（异常）→ 不改
    const len = span[1] - span[0] + 1;              // 区间跨度（含端点）
    if (!(len > 18 && len < 30)) return preset;     // 范围不达标 → 不改
    const beforeEnd = span[1] - year;               // 距区间末尾的年数
    if (beforeEnd < 15) return preset;
    const x = beforeEnd >= 20 ? 2 : 1;
    const num = (n) => Number(n) || 0;
    return {
      ...preset,
      quant: Math.max(0, num(preset.quant) - x),
      folly: Math.max(0, num(preset.folly) - x),
      axes: preset.axes ? preset.axes.map((a) => Math.max(0, num(a) - 10)) : preset.axes,
    };
  }

  // 节点遭遇池 NodePools（由 PoolDB 派生）：combat=各层"作战"非boss并集；noncombat=各层"非作战"非boss并集；
  //   开局随机池 = 两者并集（即全部非 boss 干员）。boss 出谁由 _enterNode 直接取 PoolDB.boss，这里仅做兼容。
  //   每个名字的年代区间取自 PersonEra（缺名回退 [[1094,1108]]）。
  // 同上：仅声明，构建在 rebuildAllDerived()。
  let _NON_BOSS = { combat: [], noncombat: [] };
  let NodePools = {};

  function rollFromPool(win, poolName) {
    const pool = NodePools[poolName];
    if (!pool) return null;
    const allNames = Object.keys(pool);
    if (!allNames.length) return null;
    // 已在编队（携带）的纯干员名集合 —— 精确匹配，杜绝被重复遭遇
    // （进节点遭遇抽取 _enterNode.pick 现与本函数同口径：标本后缀键 ≠ 本体名，允许标本与本体重合出场）
    const carried = new Set();
    try {
      const roster = (win && readVars(win)['干员编队']) || {};
      Object.keys(roster).forEach((n) => carried.add(n));
    } catch (e) {}
    // 候选：池内未被携带的干员 → 再滤掉开关表禁用的名字（开关筛网；下限保底保证一般非空）
    let candidates = allNames.filter((n) => !carried.has(n) && isNameEnabled(n));
    if (!candidates.length) candidates = allNames.filter((n) => !carried.has(n)); // 全被滤空 → 回退"未携带"池
    if (!candidates.length) candidates = allNames; // 仍空（全被携带）→ 回退全池
    const name = candidates[Math.floor(Math.random() * candidates.length)];
    const ranges = pool[name];
    const range = ranges[Math.floor(Math.random() * ranges.length)];
    const [lo, hi] = range;
    // 区间内随机整数年（含端点）
    const year = lo + Math.floor(Math.random() * (hi - lo + 1));
    return { name, year, pool: poolName };
  }

  /** 险路恶敌池名：按层数决定（3/5/隐藏层） */
  function dangerPoolForLayer(layer) {
    if (layer >= HIDDEN_LAYER) return 'dangerHidden'; // 第六层（隐藏层）
    if (layer === 5) return 'danger5';
    if (layer === 3) return 'danger3';
    return null;
  }

  /**
   * 开局随机编队：在所有非 boss 的「作战池 ∪ 非作战池」并集中随机抽 n 名。
   * 注意：这是"超库存"抽取（与局内干员库无关），让玩家开局即可体验非 boss 限定干员。
   */
  function rollInitialSquad(n = 3) {
    const set = new Set([...Object.keys(NodePools.combat), ...Object.keys(NodePools.noncombat)]);
    const arr = [...set].filter((nm) => isNameEnabled(nm)); // 开关筛网：滤掉开关表禁用的名字（下限保底，不会空）
    // 洗牌取前 n
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
  }


  // =========================================================================================
  // 【模块2.7：干员开关筛网（女性向适配入口）】
  //
  //   ── 变量契约：两个变量平级、互不写、互不覆盖，**都放在【角色卡变量】顶层** ─────────────────
  //     · jczl_custom_pool   ← 只由创意工坊脚本写（src/jczl/jczl_workshop.js）
  //           = { schema:1, chars:[{ name, 性别, 启用, 立绘, 池位, 数值, 年代, 别名 }] }
  //           含义＝“**有哪些自定义干员、放进哪些池**”。本文件开局只【读】它合入 PoolDB
  //           （见下方【创意工坊 · 本地自定义干员池】模块），**永不改写**。
  //     · jczl_custom_switch ← 只由本文件写（开局建表 / 面板开关 / 一键批量 / 刷新名单）
  //           = { schema:1, 开关:{ 干员名: boolean }, 迁移?:{ 来自, 时间 } }
  //           含义＝“**池里哪些名字不参与随机抽取**”。
  //     两者别混（这正是老版 jczl_custom / jczl_custom_pool 只差一个后缀、最容易看错的坑）：
  //       · 工坊里把某人 `启用:false` = **根本不进池**（连本面板的名单里都不会出现）；
  //       · 本表的 `false`             = **已经在池里，但不会被随机抽到**。
  //     因为都在角色卡变量里，**同一张角色卡的任意聊天互通**（换角色卡才是另一份），
  //     不再"一个聊天一份开关"——新开聊天也沿用你上次的设置。
  //
  //   ── 老档兼容（一次性迁移，实现见 readSwitchTable / persistSwitchTable）───────────────
  //     · 旧版把开关存在**聊天变量** jczl_custom（扁平名表 { 干员名: boolean }）。
  //     · 读变量优先级：角色卡 jczl_custom_switch（非空）→ 全局 jczl_custom_switch（非空·
  //       无角色卡兜底）→ 旧聊天变量 jczl_custom（只用来迁移）→ 角色卡里的空表 → 新建空表。
  //       ⚠ **空表不含任何信息**，所以它压不住上面那些有数据的来源（空表压真数据＝悄悄丢设置）。
  //     · 迁移＝写进角色卡变量 → **回读校验通过**才删掉该聊天的旧键 ── 旧聊天变量自此永不参与
  //       判定，既不会在新聊天里"复活"，也不会和其他旧聊天互相污染。
  //     · 三处都没有 → 写一张空表（语义仍是"全员启用"＝原行为），保证新变量一定存在：
  //       旧档玩家不会因为没点过「⟳ 刷新名单」而永远拿不到角色卡变量。
  //     · 全局 jczl_custom_switch 只作**只读兜底**，不主动迁移进角色卡（否则一份全局表会被
  //       复制进玩家的每一张角色卡，等于污染）。
  //
  //   ── 语义 / 名单 / 下限（与旧版完全一致）──────────────────────────────────────────────
  //   语义：false 的名字不参与任何 PoolDB 随机抽取（节点遭遇 / boss / 闲暇娱乐 / 开局随机出身）。
  //   来源：名单 100% 派生自 PoolDB（层 1~5 的 作战∪非作战∪boss，**不含 hiddenBoss**），PoolDB 永不被改动。
  //         名单**从不自动生成**：只有玩家按「⟳ 刷新名单」才整表写入（保留既有开关，新增名补 true、消失名删）。
  //   硬性下限（作者拍板）：每个 作战/非作战 池 ≥5 人，每个 boss 池 ≥2 人；隐藏池不可改（不写入）。
  //     · 单独禁用某人：任一含她的池会跌破下限 → **拒绝写入**（逐池精准校验）；
  //     · 一键批量（全关/只留女/只留男）：先应用后逐池补足（clamp），并回报恢复名单。
  //   性别（作者拍板：PoolDB 条目加可选 `性别` 字段）：缺省 '女'；'男' / '非人' 显式标注。
  //   不受筛影响：固定 boss（收藏品驱动）、隐藏层 boss（hiddenBoss）、标本库手动/随机挑选、AI 自建敌方卡。
  // =========================================================================================
  const FLOOR = { 作战: 5, 非作战: 5, boss: 2 };
  /** 开关表：角色卡变量顶层键（与创意工坊的 jczl_custom_pool 同级） */
  const SWITCH_KEY = 'jczl_custom_switch';
  /** 旧版开关表：聊天变量顶层键。只作一次性迁移源，日常判定永不读它 */
  const SWITCH_KEY_LEGACY_CHAT = 'jczl_custom';
  const CUSTOM_POOL_TYPES = ['作战', '非作战', 'boss'];
  const CUSTOM_LAYERS = ['1', '2', '3', '4', '5'];

  /** 层 1~5 全部池子的去重名单（不含 hiddenBoss）。 */
  let CUSTOM_NAMES = [];

  /** 短对局合并池缓存：{ 短对局层号 → { 作战:[], 非作战:[], boss:[] } }。
   *  null = 待重建；由 rebuildAllDerived() 置空（它是"池子变了"的唯一钩子，创意工坊合入后正好再跑一次）。 */
  let SHORT_POOL_CACHE = null;

  /** 取（并按需构建）短对局合并池。只读 PoolDB，不改它 —— 干员开关的逐池下限、POOL_BY_NAME、
   *  创意工坊的池位展示全部继续按**原 5 层**口径工作，互不干扰。 */
  function shortPoolDB() {
    if (SHORT_POOL_CACHE) return SHORT_POOL_CACHE;
    const out = {};
    Object.keys(SHORT_POOL_MERGE).forEach((key) => {
      const merged = { 作战: [], 非作战: [], boss: [] };
      SHORT_POOL_MERGE[key].forEach((src) => {
        const pl = PoolDB[src] || {};
        ['作战', '非作战', 'boss'].forEach((t) => {
          (pl[t] || []).forEach((e) => {
            if (!e || !e.name) return;
            if (!merged[t].some((x) => x.name === e.name)) merged[t].push(e);   // 同名只留一条（层间有重复人）
          });
        });
      });
      out[key] = merged;
    });
    SHORT_POOL_CACHE = out;
    return out;
  }

  /** 派生表全量重建：内置表定义完成时调用一次；【创意工坊】自定义池合入后再调一次。
   *  保证 POOL_BY_NAME / NodePools / 干员开关名单 CUSTOM_NAMES 全部读取合并后的池，
   *  不残留旧快照（本地优先、幂等，重复执行不会叠加）。 */
  function rebuildAllDerived() {
    SHORT_POOL_CACHE = null;   // 池子（含创意工坊自定义）变了 → 短对局合并池作废，下次用到时重建
    POOL_BY_NAME = (() => {
      const m = {};
      CUSTOM_LAYERS.forEach((l) => {
        CUSTOM_POOL_TYPES.forEach((t) => { (PoolDB[l][t] || []).forEach((e) => { if (!m[e.name]) m[e.name] = e; }); });
      });
      (PoolDB.hiddenBoss || []).forEach((e) => { if (!m[e.name]) m[e.name] = e; });
      // 别称同键：池里登记的是标准名，但旧档/AI 可能按别称写（阿尔图罗等）→ 一并登记，查表不落空。
      Object.keys(OP_ALIAS).forEach((a) => { if (m[OP_ALIAS[a]] && !m[a]) m[a] = m[OP_ALIAS[a]]; });
      return m;
    })();
    _NON_BOSS = (() => {
      const c = new Set(), nc = new Set();
      CUSTOM_LAYERS.forEach((l) => {
        const pl = PoolDB[l] || {};
        (pl.作战 || []).forEach((e) => c.add(e.name));
        (pl.非作战 || []).forEach((e) => nc.add(e.name));
      });
      return { combat: [...c], noncombat: [...nc] };
    })();
    NodePools = {
      combat: Object.fromEntries(_NON_BOSS.combat.map((n) => [n, eraRanges(n)])),
      noncombat: Object.fromEntries(_NON_BOSS.noncombat.map((n) => [n, eraRanges(n)])),
      danger3: Object.fromEntries((PoolDB[3].boss || []).map((e) => [e.name, eraRanges(e.name)])),
      danger5: Object.fromEntries((PoolDB[5].boss || []).map((e) => [e.name, eraRanges(e.name)])),
      dangerHidden: Object.fromEntries((PoolDB.hiddenBoss || []).map((e) => [e.name, eraRanges(e.name)])),
    };
    CUSTOM_NAMES = (() => {
      const s = new Set();
      CUSTOM_LAYERS.forEach((l) => {
        const pl = PoolDB[l] || {};
        CUSTOM_POOL_TYPES.forEach((t) => (pl[t] || []).forEach((e) => s.add(e.name)));
      });
      return [...s];
    })();
  }
  rebuildAllDerived();

  // =========================================================================================
  // 【创意工坊 · 本地自定义干员池】（读变量合入）
  //   本地 UI 脚本（src/jczl/jczl_workshop.js，带按钮 + 汉化表单）把玩家填写的自定义干员写成变量：
  //     顶层键 jczl_custom_pool = { schema, chars:[…] }（写入优先角色卡变量，无角色卡回退全局变量；
  //     主文件读取同理：角色卡优先、全局兜底）
  //   主游戏在开局时【同步】读取（无异步竞态，天然防投空）→ 转换成三张表 → 本地优先合入 → 重建派生表。
  //   防崩口径：
  //    · 无角色卡时 getVariables({type:'character'}) 可能抛错 → try/catch 回退全局变量；
  //    · 结构逐段校验，空表 / 非法条目一律跳过，不影响任何现有行为；
  //    · 合入幂等（每次全量重建派生表），重复执行 / 热更新重跑不会叠加。
  // =========================================================================================
  const CUSTOM_POOL_KEY = 'jczl_custom_pool';
  let customMerged = false;        // 已成功合入（幂等闸）

  /** 读自定义干员池变量：优先角色卡变量，回退全局变量。任何异常/缺省 → null。 */
  function readCustomPoolVars() {
    try {
      const v = getVariables({ type: 'character' });
      const p = v && v[CUSTOM_POOL_KEY];
      if (p && typeof p === 'object') return p;
    } catch (e) { /* 无角色卡等情况：忽略，回退全局 */ }
    try {
      const g = getVariables({ type: 'global' });
      const p = g && g[CUSTOM_POOL_KEY];
      if (p && typeof p === 'object') return p;
    } catch (e) {}
    return null;
  }

  /** 单条 UI 条目 → 三表可合入条目；非法 / 缺名 → null。 */
  function charToPoolEntry(ch) {
    if (!ch || typeof ch !== 'object') return null;
    const name = String(ch.name == null ? '' : ch.name).trim();
    if (!name) return null;
    const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
    const norm3 = (a) => {
      const arr = Array.isArray(a) ? a.map((x) => Math.max(0, Math.min(100, num(x, 50)))) : [50, 50, 50];
      while (arr.length < 3) arr.push(50);
      return arr.slice(0, 3);
    };
    const stats = (ch.数值 && typeof ch.数值 === 'object') ? ch.数值 : {};
    const art = (ch.立绘 && typeof ch.立绘 === 'object') ? ch.立绘 : {};
    const useId = art.模式 === 'id' && String(art.id || '').trim();
    const opEntry = {
      q: useId ? '' : String(art.q || ''),
      a: useId ? '' : String(art.a || ''),
      bg: String(art.bg || ''),
      id: useId ? String(art.id).trim() : '',
      full: !!useId,
    };
    const eras = (Array.isArray(ch.年代) ? ch.年代 : [])
      .filter((r) => Array.isArray(r) && r.length >= 2 && isFinite(num(r[0], NaN)) && isFinite(num(r[1], NaN)) && num(r[0]) <= num(r[1]))
      .map((r) => [num(r[0]), num(r[1])]);
    if (!eras.length) eras.push([1094, 1108]);
    const pools = (ch.池位 && typeof ch.池位 === 'object') ? ch.池位 : {};
    const poolEntries = [];
    Object.keys(pools).forEach((layerKey) => {
      const types = pools[layerKey];
      if (!types || typeof types !== 'object') return;
      Object.keys(types).forEach((typeKey) => {
        if (types[typeKey] === true && (typeKey === '作战' || typeKey === '非作战' || typeKey === 'boss')) {
          poolEntries.push({ layer: layerKey, type: typeKey });
        }
      });
    });
    // ⚠ 隐藏层 boss 池位**不再支持**（作者拍板：隐藏层 boss 固定为 HIDDEN_BOSS「希尔达」，不做自定义）。
    //   原因：PoolDB.hiddenBoss 是**扁平数组**（一排人），而这里表达的是「层 → 类型 → 名单」的抽屉形状；
    //   旧写法会往数组上挂一个非索引属性 `boss`，所有按索引遍历的读取方（rebuildAllDerived / _pickDanger）
    //   都看不见它 —— 结果是静默丢人 + 控制台却打印"新增 1"的假成功。
    //   所以这条入口直接摘掉：老数据里的 `池位.hiddenBoss` 不再产生任何池位，由 mergeCustomPools 统一告警提示。
    return {
      name,
      gender: ['男', '非人'].indexOf(ch.性别) >= 0 ? ch.性别 : '女',
      aliases: (Array.isArray(ch.别名) ? ch.别名 : []).map((a) => String(a).trim()).filter(Boolean),
      opEntry,
      eras,
      poolEntries,
      quant: Math.max(0, num(stats.quant, 5)),
      folly: Math.max(0, num(stats.folly, 1)),
      axes: norm3(stats.axes),
      rev: norm3(stats.rev),
    };
  }

  /** chars 列表 → { operatorDB, poolDB, personEra, ignoredHidden }（同名只取第一条，别名同键）。
   *  ignoredHidden = 老数据里勾过「隐藏层boss池位」的名字：该池位已废弃（隐藏层 boss 固定希尔达），
   *  这里只把它们收集起来交给 mergeCustomPools 告警，不产生任何池位。 */
  function charsToCustomTables(chars) {
    const operatorDB = {}, poolDB = {}, personEra = {};
    const seen = new Set();
    const ignoredHidden = [];
    (Array.isArray(chars) ? chars : []).forEach((ch) => {
      if (!ch || ch.启用 === false) return;   // 未启用 → 不入池
      const t = charToPoolEntry(ch);
      if (!t || seen.has(t.name)) return;     // 非法 / 同名 → 跳过（列表靠前优先）
      if (ch.池位 && ch.池位.hiddenBoss) ignoredHidden.push(t.name);   // 废弃池位：只记录，不落池
      seen.add(t.name);
      operatorDB[t.name] = { ...t.opEntry };
      personEra[t.name] = t.eras;
      (t.aliases || []).forEach((al) => {
        if (!al || al === t.name || seen.has(al)) return;
        seen.add(al);
        operatorDB[al] = { ...t.opEntry };
        personEra[al] = t.eras;
      });
      t.poolEntries.forEach(({ layer, type }) => {
        const target = (poolDB[layer] = poolDB[layer] || {});
        const arr = (target[type] = target[type] || []);
        if (!arr.some((x) => x.name === t.name)) arr.push({ name: t.name, quant: t.quant, folly: t.folly, axes: t.axes, rev: t.rev, 性别: t.gender });
      });
    });
    return { operatorDB, poolDB, personEra, ignoredHidden };
  }

  /** 合入三张表（本地优先）→ 重建派生表。必须幂等：已有标记则直接返回。 */
  function mergeCustomPools(custom) {
    if (customMerged) return;
    const src = (custom && typeof custom === 'object') ? custom : {};
    const op = (src.operatorDB && typeof src.operatorDB === 'object') ? src.operatorDB : null;
    const pd = (src.poolDB && typeof src.poolDB === 'object') ? src.poolDB : null;
    const pe = (src.personEra && typeof src.personEra === 'object') ? src.personEra : null;
    if (!op && !pd && !pe) return;   // 空表视为没有，不置标记（下次开局再读）
    let added = 0, replaced = 0;
    // ① OperatorDB：扁平表，本地键整体覆盖（别名键直接写进来即可）
    if (op) {
      Object.keys(op).forEach((k) => {
        const e = op[k];
        if (!e || typeof e !== 'object') return;
        const had = Object.prototype.hasOwnProperty.call(OperatorDB, k);
        OperatorDB[k] = e;
        if (had) replaced++; else added++;
      });
    }
    // ③ PersonEra：扁平表，本地键整体覆盖
    if (pe) {
      Object.keys(pe).forEach((k) => {
        const v = pe[k];
        if (!Array.isArray(v)) return;
        const had = Object.prototype.hasOwnProperty.call(PersonEra, k);
        PersonEra[k] = v;
        if (had) replaced++; else added++;
      });
    }
    // ② PoolDB：层 → 类型 → 名字去重；同名本地条目顶掉内置，新名追加（支持新层键/新类型）
    //   ⚠ hiddenBoss 不是这个形状（它是扁平数组），一律跳过 —— 见 charToPoolEntry 的说明。
    //     走到这里的 hiddenBoss 只可能来自手写变量；跳过 + 告警，绝不往数组上挂属性。
    if (pd) {
      Object.keys(pd).forEach((layerKey) => {
        if (layerKey === 'hiddenBoss') {
          console.warn('[集成战略] 自定义池里的 hiddenBoss 池位已废弃（隐藏层 boss 固定为「希尔达」），已忽略。');
          return;
        }
        const layer = pd[layerKey];
        if (!layer || typeof layer !== 'object') return;
        if (!PoolDB[layerKey] || typeof PoolDB[layerKey] !== 'object') PoolDB[layerKey] = {};
        Object.keys(layer).forEach((typeKey) => {
          const arr = layer[typeKey];
          if (!Array.isArray(arr)) return;
          const target = (PoolDB[layerKey][typeKey] = PoolDB[layerKey][typeKey] || []);
          arr.forEach((entry) => {
            if (!entry || typeof entry !== 'object' || !entry.name) return;
            const idx = target.findIndex((x) => x && x.name === entry.name);
            if (idx >= 0) { target[idx] = entry; replaced++; }
            else { target.push(entry); added++; }
          });
        });
      });
    }
    customMerged = true;
    try { rebuildAllDerived(); } catch (e) { console.warn('[集成战略] 自定义池派生表重建失败：', e && e.message ? e.message : e); }
    console.info('[集成战略] 已合入本地自定义干员池：新增 ' + added + ' · 覆盖 ' + replaced + '（来源变量 ' + CUSTOM_POOL_KEY + '）');
    // 废弃池位告警：老数据里勾过「隐藏层boss」的人不会进任何池 —— 说清楚，别再给"新增 N"的假成功。
    const ignoredHidden = Array.isArray(src.ignoredHidden) ? src.ignoredHidden : [];
    if (ignoredHidden.length) {
      console.warn('[集成战略] 以下自定义角色的「隐藏层boss池位」已废弃，未生效（隐藏层 boss 固定为「'
        + HIDDEN_BOSS + '」，不支持自定义）：' + ignoredHidden.join('、')
        + '。人物本身仍在（立绘/数值可用），只是不会出现在隐藏层 boss 位；若想让她当首领，请改勾第 3 或第 5 层的 boss 池位。');
    }
  }

  /** 开局入口：同步读变量 → 转换 → 合入（幂等；没写变量则不置标记，下次开局再读）。 */
  function mergeCustomPoolsFromVars() {
    if (customMerged) return;
    const raw = readCustomPoolVars();
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.chars)) return;
    const tables = charsToCustomTables(raw.chars);
    if (!Object.keys(tables.operatorDB).length && !Object.keys(tables.poolDB).length && !Object.keys(tables.personEra).length) return;
    mergeCustomPools(tables);
  }

  // ─────────────────────────────────────────────────────────────────────────────────────
  // 开关表读写层（角色卡变量为准 · 全局只读兜底 · 旧聊天变量一次性迁移）
  //   面板 / ⟳刷新 / 一键批量 / 各处抽取前的筛网 **全部走这里**，共用同一份缓存，
  //   杜绝"一处读聊天变量、另一处读角色卡变量"这种分叉（老版真出现过）。
  // ─────────────────────────────────────────────────────────────────────────────────────
  /** 已解析的扁平开关表缓存：{ table, scope, migrated }。
   *  · table   = { 干员名: boolean }，只装纯数据，绝不装 Variables 活对象
   *  · scope   = 'character' | 'global' | 'legacy-chat' | 'none'（面板与自检显示用）
   *  · migrated= 本次是否发生了"旧聊天变量→角色卡变量"迁移 */
  let _switchCache = null;

  /** 把变量值解析成扁平开关表；不是开关表 → null。
   *  容错两种形态：① 新版 { schema, 开关:{名:bool}, … } ② 扁平 { 名:bool }（旧聊天变量 / 手写）。
   *  只收布尔（手写的 'true'/'false' 也认），其余键一律丢弃，坏数据不会带进判定。 */
  function parseSwitchTable(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const src = (raw.开关 && typeof raw.开关 === 'object' && !Array.isArray(raw.开关)) ? raw.开关 : raw;
    const out = {};
    Object.keys(src).forEach((k) => {
      if (k === 'schema' || k === '说明' || k === '迁移' || k === '更新') return;
      const v = src[k];
      if (v === true || v === false) out[k] = v;
      else if (v === 'true' || v === 'false') out[k] = (v === 'true');
    });
    return out;
  }

  /** 容器里是否存在开关表键。空表 {} 也算"有"：它语义＝全员启用，且必须能压住全局兜底。 */
  function hasSwitchKey(container) {
    return !!container && typeof container === 'object' && Object.prototype.hasOwnProperty.call(container, SWITCH_KEY);
  }

  /** 读三种作用域里的原始开关表（缺省/失败 → null）。 */
  function readSwitchScopes() {
    const out = { character: null, global: null, legacyChat: null };
    try {
      const v = getVariables({ type: 'character' });
      if (hasSwitchKey(v)) out.character = parseSwitchTable(v[SWITCH_KEY]);
    } catch (e) { /* 没打开角色卡：getVariables({type:'character'}) 会抛错 */ }
    try {
      const g = getVariables({ type: 'global' });
      if (hasSwitchKey(g)) out.global = parseSwitchTable(g[SWITCH_KEY]);
    } catch (e) {}
    try {
      const c = getVariables({ type: 'chat' });
      if (c && Object.prototype.hasOwnProperty.call(c, SWITCH_KEY_LEGACY_CHAT)) {
        out.legacyChat = parseSwitchTable(c[SWITCH_KEY_LEGACY_CHAT]);
      }
    } catch (e) {}
    return out;
  }

  /** 写开关表：角色卡优先，无角色卡回退全局。返回实际写入的作用域；两处都写不了 → null。 */
  function persistSwitchTable(table, migrationInfo) {
    const payload = { schema: 1, 开关: { ...(table || {}) } };
    if (migrationInfo) payload.迁移 = migrationInfo;
    for (const scope of ['character', 'global']) {
      try {
        updateVariablesWith((vars) => {
          const box = (vars && typeof vars === 'object') ? vars : {};
          box[SWITCH_KEY] = payload;
          return box;
        }, { type: scope });
        return scope;
      } catch (e) { /* 该作用域不可写（无角色卡 / 无全局）→ 试下一个 */ }
    }
    return null;
  }

  /** 回读校验：刚写的开关表是否真的落地（迁移时用它决定能不能删旧聊天变量）。 */
  function verifySwitchPersisted(scope, table) {
    if (!scope) return false;
    try {
      const v = getVariables({ type: scope });
      const got = hasSwitchKey(v) ? parseSwitchTable(v[SWITCH_KEY]) : null;
      if (!got) return false;
      const want = table || {};
      return Object.keys(want).every((k) => got[k] === want[k]);
    } catch (e) { return false; }
  }

  /** 删掉当前聊天里的旧版开关键（迁移成功后调用；删不掉也无妨——日常判定已不再读它）。 */
  function purgeLegacyChatSwitch() {
    try {
      const c = getVariables({ type: 'chat' });
      if (!c || !Object.prototype.hasOwnProperty.call(c, SWITCH_KEY_LEGACY_CHAT)) return;
      updateVariablesWith((vars) => {
        if (vars && typeof vars === 'object') delete vars[SWITCH_KEY_LEGACY_CHAT];
        return vars;
      }, { type: 'chat' });
    } catch (e) {}
  }

  /** 载入开关表（进程内只跑一次，之后走缓存）。首次调用做：读取 → 迁移 → 或建空表。 */
  function loadSwitchTable() {
    if (_switchCache) return _switchCache;
    const s = readSwitchScopes();
    const hasData = (t) => !!t && Object.keys(t).length > 0;
    // ① 角色卡里有**非空**表：权威，直接用
    if (hasData(s.character)) {
      _switchCache = { table: s.character, scope: 'character', migrated: false };
      return _switchCache;
    }
    // ② 全局里有非空表：只读兜底。**不迁进角色卡**，否则一份全局表会被复制进玩家的每张卡
    //   （玩家下次一拨开关，writeSwitchTable 会以这张表为底整表写进角色卡，等于自动补种）
    if (hasData(s.global)) {
      _switchCache = { table: s.global, scope: 'global', migrated: false };
      return _switchCache;
    }
    // ③ 旧聊天变量：一次性迁移 → 回读校验通过 → 才删旧键（旧变量自此不再参与判定）
    if (s.legacyChat) {
      const legacy = s.legacyChat;
      const scope = persistSwitchTable(legacy, { 来自: 'chat.' + SWITCH_KEY_LEGACY_CHAT, 时间: new Date().toISOString() });
      if (scope && verifySwitchPersisted(scope, legacy)) {
        purgeLegacyChatSwitch();
        _switchCache = { table: legacy, scope, migrated: true };
        console.info('[集成战略] 干员开关已从旧聊天变量 ' + SWITCH_KEY_LEGACY_CHAT + ' 迁移到' +
          (scope === 'character' ? '角色卡变量' : '全局变量') + '（' + SWITCH_KEY + '，' +
          Object.keys(legacy).length + ' 条），旧键已清除。');
        return _switchCache;
      }
      // 两处都写不进去（无角色卡且无全局）：本次仍按旧表只读运行，旧键保留 —— 宁可照旧玩，不可丢设置
      _switchCache = { table: legacy, scope: 'legacy-chat', migrated: false };
      console.warn('[集成战略] 干员开关迁移失败（角色卡变量/全局变量都写不进去），本次按旧聊天变量只读运行。');
      return _switchCache;
    }
    // ④ 角色卡里已经有一张空表：就用它（语义＝全员启用），不必再写一次
    //   ⚠ 空表**不能**压住上面那些有数据的来源（它不含任何信息，压住就等于丢设置）。
    if (s.character) {
      _switchCache = { table: s.character, scope: 'character', migrated: false };
      return _switchCache;
    }
    // ⑤ 三处都没有：建一张空表（语义＝全员启用＝原行为）。
    //    ⚠ 这一步是给「旧档玩家」兜底的：不建表，他就永远拿不到角色卡变量（只有按刷新才会写）。
    const scope = persistSwitchTable({}, null);
    _switchCache = { table: {}, scope: scope || 'none', migrated: false };
    if (!scope) console.warn('[集成战略] 干员开关空表写入失败（无角色卡且无全局变量可写），本局按「全员启用」运行。');
    return _switchCache;
  }

  /** 读开关表（扁平名表；无表/异常 → {}＝全员启用）。首次调用负责迁移/建表。 */
  function readSwitchTable() {
    try { return loadSwitchTable().table; } catch (e) { return {}; }
  }

  /** 开关表目前存在哪里（面板/自检显示用）。 */
  function switchScope() {
    try { return loadSwitchTable().scope; } catch (e) { return 'none'; }
  }

  /** 丢掉缓存重新载入（面板打开时用：外部动过变量也能读到最新；已迁过就不会再迁）。 */
  function reloadSwitchTable() {
    _switchCache = null;
    return readSwitchTable();
  }

  /** 写开关表：fn 收到当前表（浅拷贝），返回改后表。写成功 → 刷新缓存并返回 true。 */
  function writeSwitchTable(fn) {
    const cur = readSwitchTable();
    let next;
    try { next = fn({ ...cur }); } catch (e) {
      console.warn('[集成战略] 干员开关写入前的处理函数抛错：', e && e.message ? e.message : e);
      return false;
    }
    const clean = parseSwitchTable(next) || {};
    const scope = persistSwitchTable(clean, null);
    if (!scope) {
      console.warn('[集成战略] 干员开关写入失败（角色卡变量/全局变量都写不进去）。');
      return false;
    }
    _switchCache = { table: clean, scope, migrated: false };
    return true;
  }

  /** 名字是否参与随机：开关表里显式 false 才禁用；不在表内（未刷新/新增名）＝启用。 */
  function isNameEnabled(name) {
    const c = readSwitchTable();
    const key = cleanName(String(name == null ? '' : name));
    if (!key) return true;
    if (Object.prototype.hasOwnProperty.call(c, key)) return c[key] !== false;
    return true;
  }

  /** 滤掉禁用的名字。 */
  function filterNames(names) {
    return (names || []).filter((n) => isNameEnabled(n));
  }

  /** 干员性别：PoolDB 条目可选 `性别` 字段，缺省 '女'（别名/标本后缀归一后查表）。 */
  function genderOf(name) {
    const e = POOL_BY_NAME[cleanName(String(name == null ? '' : name))];
    return (e && e.性别) || '女';
  }

  /** 某池当前启用人数（c 里显式 false 才算禁用；缺省＝启用）。 */
  function poolEnabledCount(names, c) {
    let n = 0;
    names.forEach((nm) => { if (c[nm] !== false) n++; });
    return n;
  }

  /** 含 name 的所有池（层·类型），按 PoolDB 现算。 */
  function poolsOf(name) {
    const out = [];
    CUSTOM_LAYERS.forEach((l) => {
      const pl = PoolDB[l] || {};
      CUSTOM_POOL_TYPES.forEach((t) => {
        const names = (pl[t] || []).map((e) => e.name);
        if (names.indexOf(name) >= 0) out.push({ 层: l, 类型: t, names, 下限: FLOOR[t] });
      });
    });
    return out;
  }

  /**
   * 把 name 置为 enabled 后，是否会让任一含她的池跌破下限（逐池精准校验）。
   * 启用方向永不违规（只会增加人数）；违规只可能发生在「禁用」方向。
   * @returns {{ violates: boolean, msg: string }}
   */
  function wouldViolatePool(name, enabled) {
    if (enabled) return { violates: false, msg: '' };
    const c = readSwitchTable();
    const next = { ...c, [name]: false };
    for (const p of poolsOf(name)) {
      const cnt = poolEnabledCount(p.names, next);
      if (cnt < p.下限) {
        return {
          violates: true,
          msg: '「' + name + '」若禁用，第' + p.层 + '层·' + p.类型 + '池只剩 ' + cnt + ' 人（下限 ' + p.下限 + '）',
        };
      }
    }
    return { violates: false, msg: '' };
  }

  /**
   * 逐池补足到下限（作战/非作战 5、boss 2）：把本批关掉的名字按 PoolDB 顺序重新启用直到达标。
   * 池子本身不足下限（如第1层作战只有 4 人）→ 该池全员保持启用。
   * @returns {{ custom: object, restored: string[] }} restored 为去重恢复名单
   */
  function clampCustom(custom) {
    const c = { ...custom };
    const restored = [];
    CUSTOM_LAYERS.forEach((l) => {
      const pl = PoolDB[l] || {};
      CUSTOM_POOL_TYPES.forEach((t) => {
        const names = (pl[t] || []).map((e) => e.name);
        if (!names.length) return;
        const floor = FLOOR[t];
        let i = 0;
        while (poolEnabledCount(names, c) < floor && i < names.length) {
          const nm = names[i++];
          if (c[nm] === false) { c[nm] = true; restored.push(nm); }
        }
      });
    });
    return { custom: c, restored: [...new Set(restored)] };
  }

  /**
   * 从 PoolDB 重新生成开关表并整表写入（玩家按「⟳ 刷新名单」= 名单唯一的生成入口）。
   *  · 首写：全部 true；再刷：保留既有开关，新增名补 true、消失名删除（自改 PoolDB 后刷新不重置选择）。
   *  · hiddenBoss 永不写入。返回生成的名单人数 + 落盘是否成功。
   */
  function refreshCustom() {
    const old = readSwitchTable();
    const next = {};
    CUSTOM_NAMES.forEach((nm) => {
      next[nm] = Object.prototype.hasOwnProperty.call(old, nm) ? old[nm] : true;
    });
    const saved = writeSwitchTable(() => next);
    return { count: CUSTOM_NAMES.length, custom: next, saved };
  }

  /** 一键批量动作：enabledOf(名字)→是否启用；应用后 clamp 补足下限。返回最终表、恢复名单与落盘状态。 */
  function applyBatch(enabledOf) {
    const c = { ...readSwitchTable() };          // 拷贝：绝不就地改缓存里的表
    CUSTOM_NAMES.forEach((nm) => { c[nm] = enabledOf(nm); });
    const r = clampCustom(c);
    const saved = writeSwitchTable(() => r.custom);
    return { restored: r.restored, custom: r.custom, saved };
  }


  // =========================================================================================
  // 【模块2.8：剧情日志 / $时间线记忆库】
  //   剧情日志（本局流水，AI 写）：键＝故事内时间 `年,月,日`（英文逗号分隔，公元前写负年份），
  //     值＝一段剧情内容。没有其它固定字段；键无限扩展（$meta 已在 CONTAINERS_WITH_META 开路）。
  //   $时间线记忆库（存档库，**纯前端写 / AI 不可见**）：
  //     { "<四位随机编号>": { "年,月,日": 剧情内容 } } —— 通关/存档时由 _archiveChronicleInto() 整段搬入；
  //     熔断 / 失败 / 开新局都不碰它（见 _resetRunScopedDraft）。
  //     需要 AI 知情时由世界书 EJS 定点注入（读 `_当前启用时间线` 或玩家消息里的编号），
  //     绝不把整个库直接塞进上下文。
  //   排序（作者要求）：AI 新增条目只会被 MVU 追加到最末，前端要按年月日重排：
  //     · 取键里出现的数字依次当年/月/日（`1234,5,6` → 1234/5/6；`-678,9月` → -678/9/0）；
  //     · 格式写错也照样能排：退化为"最靠前的数字当年份"（上例即 -678）；
  //     · 一个数字都没有 → 排到最后，再按原键字符串稳定排序；
  //     · 只在顺序真的变了才回写（幂等），避免每轮无意义写变量。
  // =========================================================================================

  /** 把一个剧情日志键解析成排序用的数字组 [年,月,日,...]；完全没有数字 → null（排最后）。 */
  function chronicleKeyParts(key) {
    const s = String(key == null ? '' : key).trim();
    // 只取**整数**数字串（-?\d+）：正常键 `1094,3,12`、写错的 `1094年3月`、`-678,9月`、`1094.3.12`
    // 都能取到；不认小数，免得 `1094.3` 被当成一个数把月日吃掉。
    const nums = (s.match(/-?\d+/g) || []).map(Number);
    if (!nums.length) return null;
    return [nums[0], nums[1] === undefined ? 0 : nums[1], nums[2] === undefined ? 0 : nums[2]]
      .concat(nums.slice(3));   // 第 4 个及以后的数字当"同日后缀序号"
  }

  /** 剧情日志键排序：年→月→日→后缀→原键字符串（同值稳定）。返回新数组，不改入参。 */
  function sortChronicleKeys(keys) {
    const list = (keys || []).map((k, i) => ({ k, i, p: chronicleKeyParts(k) }));
    list.sort((a, b) => {
      if (!a.p || !b.p) {
        if (!a.p && !b.p) return (a.k < b.k ? -1 : (a.k > b.k ? 1 : a.i - b.i));
        return a.p ? -1 : 1;   // 没有数字的排最后
      }
      const n = Math.max(a.p.length, b.p.length);
      for (let i = 0; i < n; i++) {
        const x = a.p[i] === undefined ? 0 : a.p[i];
        const y = b.p[i] === undefined ? 0 : b.p[i];
        if (x !== y) return x - y;
      }
      return a.k < b.k ? -1 : (a.k > b.k ? 1 : a.i - b.i);
    });
    return list.map((x) => x.k);
  }

  /** 剧情日志里 $meta 之类的非条目键不参与搬移/排序。 */
  function isChronicleEntryKey(k) { return String(k || '').charAt(0) !== '$'; }

  // =========================================================================================
  // 【模块2.9：标本库分组读取工具】
  //   标本库是**两层**容器：{ "<四位数时间线编号>": { "<干员名_两位编号>": 干员卡 } }
  //   · 内层键格式与旧版一致（`名_xx`，cleanName 仍剥后缀），所以卡片渲染/立绘匹配一行都不用改；
  //   · 外层就是「她属于哪条时间线」。前端只在归档时写外层，AI 只往已有组里补字段。
  //   ⚠ 所有"按键找卡/列全部卡/数一数有多少卡"的地方**一律走这里**，不要各处手写两层遍历 ——
  //     一旦有人在别处直接按第一层下标取卡（而不是走本文件这几个函数），
  //     拿到的就是"某个时间线组"这个容器本身，卡片渲染会静默出错。
  //   只有四位数字的组键才当时间线；其它键（AI 误写/手工改坏）落进「异常组」，界面末尾只读展示。
  // =========================================================================================

  /** 是否合法的时间线组键（四位数字，如 '1234'）。 */
  function isTimelineGroupKey(k) { return /^\d{4}$/.test(String(k == null ? '' : k).trim()); }

  /** 取一个"卡容器"（对象且非数组）；不是 → null。$meta 之类的键不算卡，由调用方过滤。 */
  function _specBagOf(o) { return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null; }

  /** 标本库对象本身（类型兜底）。 */
  function _specLib(v) {
    const o = v && v['标本库'];
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }

  /** 遍历时间线组：cb(编号, 卡容器)。顺序 = 键字典序（渲染时由界面自己再排）。 */
  function specGroups(v) {
    const lib = _specLib(v);
    const out = [];
    Object.keys(lib).forEach((id) => {
      const bag = _specBagOf(lib[id]);
      if (bag) out.push({ id: id, bag: bag, timeline: isTimelineGroupKey(id) });
    });
    return out;
  }

  /** 某条时间线下的全部卡键（组不存在 → []）。 */
  function specKeysIn(v, id) {
    const bag = _specBagOf(_specLib(v)[String(id || '')]);
    return bag ? Object.keys(bag).filter(isChronicleEntryKey) : [];
  }

  /** 全库卡键（跨所有时间线组；同一键不会出现在两个组里）。 */
  function specKeys(v) {
    const out = [];
    specGroups(v).forEach((g) => {
      Object.keys(g.bag).forEach((k) => { if (isChronicleEntryKey(k)) out.push(k); });
    });
    return out;
  }

  /** 全库卡数。 */
  function specCount(v) { return specKeys(v).length; }

  /**
   * 全库**精确**找卡（不做纯名兜底）：标本身份键（`阿米娅1234`）专用。
   * 立绘/锚点必须用这个 —— 只按纯名兜底会把 A 线的她当成 B 线的她（异构体是不同的个体）。
   * @returns {{id:string, key:string, rec:object}|null}
   */
  function specFindExact(v, key) {
    const k = String(key == null ? '' : key).trim();
    if (!k) return null;
    const groups = specGroups(v).filter((g) => g.timeline);
    for (let i = 0; i < groups.length; i++) {
      const rec = groups[i].bag[k];
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) return { id: groups[i].id, key: k, rec: rec };
    }
    return null;
  }

  /**
   * 按键找卡：返回 { id, key, rec } —— id 是所在时间线编号，rec 是那张卡；找不到 → null。
   * 先全库精确匹配（标本身份靠完整键保持唯一），再按纯名兜底（只认"恰好一份同名卡"，
   * 多份同名卡时拒绝瞎猜，免得把 A 线的她当成 B 线的她）。
   */
  function specFind(v, key) {
    const exact = specFindExact(v, key);
    if (exact) return exact;
    const k = String(key == null ? '' : key).trim();
    if (!k) return null;
    const groups = specGroups(v).filter((g) => g.timeline);
    const base = cleanName(k);
    if (!base) return null;
    const hits = [];
    groups.forEach((g) => {
      Object.keys(g.bag).forEach((kk) => {
        if (!isChronicleEntryKey(kk)) return;
        if (cleanName(kk) !== base) return;
        const rec = g.bag[kk];
        if (rec && typeof rec === 'object' && !Array.isArray(rec)) hits.push({ id: g.id, key: kk, rec: rec });
      });
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /** 某个键当前落在哪个时间线组里（找不到 → ''）。 */
  function specGroupOf(v, key) { const hit = specFind(v, key); return hit ? hit.id : ''; }

  /** 非四位数字的异常组（AI 写歪/手工改坏）：{ id, bag }，只作只读展示用。 */
  function specAnomalyGroups(v) { return specGroups(v).filter((g) => !g.timeline); }

  // ---- 剧情日志变更播报的参数（作者拍板）--------------------------------------------------
  //   卡片停留 = 4500ms 起步 + 每 40 字 +1 档(500ms)，封顶 8000ms —— 日志正文 1~3 句要读得完。
  //   淡出 500ms（与 .chron-* 的 CSS 动画对齐）；队列严格串行：上一张淡出完了才弹下一张。
  const CHRONICLE_POPUP = { baseMs: 4500, perChars: 40, stepMs: 500, maxMs: 8000, fadeMs: 500 };

  /** 剧情日志日期标签：把键解析成「1094年3月12日」/「前678年9月」；解析不出 → 原样回显。
   *  公元前两种写法都认：世界书口径的负年份 `-678,9,12`，以及 AI 常写的「前678,9,12」。
   *  纯展示用，不参与排序（排序一律走 sortChronicleKeys）。 */
  function chronicleDateLabel(key) {
    const raw = String(key == null ? '' : key);
    const p = chronicleKeyParts(raw);
    if (!p) return raw;
    const bc = p[0] < 0 || raw.indexOf('前') >= 0;
    const m = p[1], d = p[2];
    return (bc ? '前' : '') + Math.abs(p[0]) + '年' + (m ? (m + '月') : '') + (d ? (d + '日') : '');
  }


  // ---- 固定 boss 规则 / 隐藏层闸门（收藏品·蚀刻章驱动） --------------------------------
  //
  //  两条互相独立的机制，判定发生在**两个不同的时间点**，不要合并：
  //    · 固定 boss  = 进节点时决定"这一仗打谁"（_enterNode → _pickDanger）
  //    · 进入隐藏层  = 离节点时决定"接下来去哪"（_leaveNode → _resolveClear）
  //
  /** 固定 boss 规则表：持有该收藏品时，对应层的 险路恶敌 固定为该干员。
   *  · 按表序命中，**先匹配先生效**（同时持有两件时以靠前的规则为准）。
   *  · 收藏品可能是打过第3层之后才拿到的 → 那时第3层已过，自然只对第5层生效。
   *  · 未命中时 boss 走各层原随机池：例如「克莱门莎」未被固定时仍留在 PoolDB[3].boss 里随机出现。
   *  · ⚠ 每层的一个格子可以是**单个名字**或**名字数组**：数组 = 这几个里随机一位（二选一/多选一）。
   *    取法见 _pickDanger：先按名查 POOL_BY_NAME 过滤掉配错的名字，再从剩下的里面随机。 */
  const FIXED_BOSS_RULES = [
    { 收藏品: '大群交触手', 3: '克莱门莎', 5: '浊心斯卡蒂' },
    // 第5层二选一：黑冠特蕾西娅 / 终曲阿米娅。
    // 抽到终曲阿米娅时，打倒并收服她 = 第一次把她编入队伍 → 授予蚀刻章「灭世圣女-救世魔王」
    // （见 ETCH_RULES / ETCH_ROSTER_KEYWORD），这是隐藏层「特殊源石」前置的唯一取得途径。
    { 收藏品: '白月光', 3: '寒灾霜星', 5: ['黑冠特蕾西娅', '终曲阿米娅'] },
  ];
  /** 隐藏层闸门：**蚀刻章是必要条件，收藏品是补齐条件** —— 两者缺一即走普通循环。
   *  （没蚀刻章就算领了收藏品、有蚀刻章不领收藏品，都只走 1~5 层正常循环） */
  const HIDDEN_GATE = { 蚀刻章: '灭世圣女-救世魔王', 收藏品: '我要吃饭' };
  /** 隐藏层（第六层）的 boss 固定为： */
  const HIDDEN_BOSS = '希尔达';
  /** 隐藏层层号：正常层 1~5 之后的**第六层**。
   *  ⚠ 顺序递增，不要用 100 之类哨兵值：$当前层数 会喂给 _recomputeLongPool 的逐层衰减循环
   *  （for L=1..层数 → 每层 ×衰减档），哨兵值会把三轴直接乘成 0；层号也直接进战报文案。 */
  const HIDDEN_LAYER = 6;
  /** 隐藏层（第六层）地图固定节点序列：单行线性，每列恰 1 个节点，无随机形态。
   *  顺序即关卡顺序：紧急作战 → 诡意行商 → 不期而遇 → 险路恶敌（末级 boss）。
   *  _layerCols / _genMap / _randomNodeType 都读它，改序列只动这一处。 */
  const HIDDEN_MAP_SEQUENCE = ['紧急作战', '诡意行商', '不期而遇', '险路恶敌'];

  // =========================================================================================
  // 【节点表现层常量】节点确认栏 / 作战伪加载页 / 任务完成条（**纯前端表现，不碰变量与判定**）
  //   · 确认栏：点地图节点 → 右缘滑入，问"要不要去、带谁去"；只有作战类带主战干员框。
  //   · 伪加载：仅作战类，点「出发前往」后盖住全屏约 5 秒（战报此时已经发出、AI 正在跑），
  //     加载结束后才放行战报/日志弹窗动画（见 _flushDeferredPresentation）。
  //   · 任务完成：作战类节点「可以离开了」的那一刻播一次黑条。
  // =========================================================================================
  /** 素材：与 HOME_BG_URL 同一个 gcore 加速仓库（仓库根目录）。 */
  const NODE_UI_ASSETS = {
    loading: 'https://gcore.jsdelivr.net/gh/ll11292631-droid/mama@main/loading.webp',
    loading2: 'https://gcore.jsdelivr.net/gh/ll11292631-droid/mama@main/loading1.webp',
    logo: 'https://gcore.jsdelivr.net/gh/ll11292631-droid/mama@main/logo_com.webp',
  };
  /** 作战类节点（= 要主战干员框 + 伪加载页 + 任务完成条的那些）。 */
  const COMBAT_NODE_TYPES = ['作战', '紧急作战', '险路恶敌'];
  function isCombatNodeType(t) { return COMBAT_NODE_TYPES.indexOf(String(t || '')) >= 0; }
  /** 确认栏里非作战节点的固定一句话（取自参考图的 INFO 文案）。 */
  const NODE_INFO_TEXT = {
    安全屋: '这里不会有人打扰，食物和水都很充足，别一直紧绷着神经了。',
    不期而遇: '新朋友、老对头……奇遇不会老去，陈旧的只有伤疤。',
    闲暇娱乐: '靠着些微小的乐趣，对抗漫漫旅程中的琐碎与困苦。',
    诡意行商: '不是盟友也不是敌人，有些人喜欢站在中间。',
  };
  /** 确认栏标题下的英文小字（纯装饰，与参考图同一位置）。 */
  const NODE_TYPE_EN = {
    作战: 'COMBAT OPS', 紧急作战: 'URGENT OPS', 险路恶敌: 'ELITE OPS',
    安全屋: 'SAFE ZONE', 不期而遇: 'ENCOUNTER', 闲暇娱乐: 'LEISURE', 诡意行商: 'MERCHANT',
  };
  /** 确认栏配色：每种节点一条色条（作战紫 / 紧急作战红 / 险路恶敌洋红 / 安全屋蓝 /
   *  不期而遇青 / 闲暇娱乐青绿 / 诡意行商绿）。值 = #node-confirm 上的 class 后缀。 */
  const NODE_TYPE_ACCENT = {
    作战: 'violet', 紧急作战: 'red', 险路恶敌: 'magenta',
    安全屋: 'blue', 不期而遇: 'cyan', 闲暇娱乐: 'teal', 诡意行商: 'green',
  };
  function nodeAccentClass(t) { const k = NODE_TYPE_ACCENT[String(t || '')]; return k ? ('nc-a-' + k) : 'nc-a-violet'; }
  /** 伪加载页的关卡编号：作战/紧急作战 = LSW-SP，险路恶敌 = LSW-EX。 */
  const LOADING_CODE_SP = 'LSW-SP';
  const LOADING_CODE_EX = 'LSW-EX';
  /** 关卡名池（作战 / 紧急作战）。⚠ 最后一条的 "(?" 也是关卡名本身的一部分，别当笔误删掉。 */
  const LOADING_LEVELS_SP = ['来杀我，色批', '蕾丝袜，爽品', '零失误，谁配', '老师我，苕皮', '来戍卫，四排(?)'];
  /** 关卡名池（险路恶敌）。 */
  const LOADING_LEVELS_EX = ['拉上我，恶行', '老色慰，鹅心'];
  /** 特例：这两个角色作为本节点遭遇时，无论节点类型都用这个关卡名。 */
  const LOADING_LEVEL_SPECIAL = { 狮蝎: '连身袜，EX', 菈玛莲: '连身袜，EX' };
  /** 底部 tips 池 —— ⚠ 作者稍后提供正式文案，这里先占位（换文案只改这一个数组）。 */
  const LOADING_TIPS = [
    '如果你想在没有经历过的情况下玩指定设定的时间线，比如我就想要全是色鬼的时间线, 就直接在首页和普瑞赛斯聊天，称<帮我找一个xx时间线加载并写入剧情日志>, 然后正常开一局就行，ai看上下文会自己写进剧情日志的',
    '希望你知道该在什么节点干什么，由于作者是屑，提示词防护聊胜于无，最好别口胡(比如声称要回家却不点熔断按钮->ai在正文让你回去了但游戏里还在对局内->我也不知道怎么修)，顺便现在跨节点的删楼回退很可能出bug',
    '标本库干员的编号不是写死的，你可以在标本库里改名，只要和原名不同就行，比如凯尔希妈妈和女儿阿米娅，或者女儿凯尔希和阿米娅妈妈(?，非要改成原名的话会乱套',
    '好想在类脑里也写一个这样的tips推送啊，很多偏门但又必要的知识不适合单开教程，但奶人又需要知道...可惜软件机制做不到',
  ];
  /** 伪加载时序：图1 停 3s → 交叉淡入图2 停 2s → 淡出 0.55s → 放行弹窗动画。 */
  const LOADING_TIMING = { firstMs: 3000, secondMs: 2000, fadeMs: 550 };

  // ---------------------------------------------------------------------------------------
  // 【短对局】（首页开关 `$短对局`；纯前端区，AI 不可见）
  //   目的：让玩家更快通关。**层号保持不变**（仍是 1/3/5，隐藏层仍是 6）—— 这是全工程的兼容基石：
  //     所有 `layer === 3` / `layer === 5` / `>= HIDDEN_LAYER` 的判定（末级节点类型、终局分支、
  //     固定 boss 槽位、隐藏层闸门、存档校验）天然继续正确，一行都不用改。
  //   只有三处口径按"层序"另算，全部集中读下面这几张表：
  //     · 换层       —— _nextLayer()：1 → 3 → 5（正常 x → x+1）
  //     · 逐层衰减   —— _layerSeq()：跑完三层只衰减 2 次（正常 5 层衰减 4 次）
  //     · 敌池       —— SHORT_POOL_MERGE：短对局层号 → 参与合并的原层号
  //   另有两处玩法补偿：第 5 层 boss 前固定补一个单独「诡意行商」（补回被跳掉的第 4 层末级行商）、
  //   隐藏关掷骰概率 ×SHORT_HIDDEN_PROB_MUL（节点总数少了约 40%，不补偿的话隐藏层几乎摸不到）。
  // ---------------------------------------------------------------------------------------
  /** 短对局层序：跳过第 2、4 层。顺序即推进顺序（唯一来源，别处不得再写 [1,3,5]）。 */
  const SHORT_LAYERS = [1, 3, 5];
  /** 正常对局层序：等距递增（与改造前的 `layer + 1` 行为逐位等价）。 */
  const FULL_LAYERS = [1, 2, 3, 4, 5];
  /** 短对局敌池合并表：短对局层号 → 拿哪几个**原层**的池子合并（作战/非作战/boss 各自按名去重）。
   *  ⚠ 原 2、4 层的 boss 池是空数组，所以 boss 合并实际是 no-op；表里照写是为了将来加 boss 时不跑偏。 */
  const SHORT_POOL_MERGE = { 1: [1, 2], 3: [2, 3], 5: [4, 5] };
  /** 短对局隐藏关概率倍率（只作用于 HIDDEN_EVENTS 的 `概率`，逐族一次掷骰的规则不变）。 */
  const SHORT_HIDDEN_PROB_MUL = 2;

  // ---- 蚀刻章授予表（长线，跨局保留）------------------------------------------------------
  //  结构见 Schema：蚀刻章[名] = { 描述, 标签 }——"简介"就是 描述（收藏品库页会一起渲染）。
  //  两条都是**第一次**语义：已有此章则整条跳过（幂等），重复调用无害。
  //    · 内部爱            ← 第一次遭遇「洁尔佩塔」；
  //    · 灭世圣女-救世魔王  ← 第一次把「终曲阿米娅」编入队伍（也是隐藏层「特殊源石」的前置之一）。
  //  判定入口：_syncEtchBadges()（进节点当场判一次 + 每次 AI 回复后兜底判一次）。
  const ETCH_RULES = [
    {
      name: '内部爱',
      描述: '你问终末地的角色怎么塞进来的，我说天意的大手',
      来源: '第一次遭遇 洁尔佩塔',
    },
    {
      name: '灭世圣女-救世魔王',
      描述: '灭世还是救世，这是个问题，救……救世啊',
      来源: '第一次把 终曲阿米娅 编入队伍',
    },
  ];
  /** 编队键的容错匹配词（数组，命中任意一个即可）：
   *   · 池里的名字是「终曲阿米娅」（见 PoolDB.hiddenBoss），图池键同名（终曲阿米娅），
   *     旧写法不再保留。 */
  const ETCH_ROSTER_KEYWORD = { '灭世圣女-救世魔王': ['炉芯终曲', '终曲阿米娅'] };
  /** 遭遇名匹配词（数组）：节点遭遇口径取 _mainTargetName + 切片字段，按"含该词"判定 */
  const ETCH_ENCOUNTER_KEYWORD = { 内部爱: ['洁尔佩塔'] };

  /** 全角 → 半角：只动 ASCII 可见区（U+FF01~FF5E）和全角空格（U+3000）。
   *  含全角连字符「－」(U+FF0D) → '-'，全角斜杠「／」→ '/'。 */
  function toHalfWidth(s) {
    return String(s == null ? '' : s)
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, ' ');
  }
  /** 变量名归一（**唯一标准口径**，全工程只有这一份）：
   *  ① 全角转半角（Ｗ→w、－→-、全角空格→空格）；
   *  ② 去掉所有空白与成对引号/括号（「」『』【】() （） "" '' ’ “ ”）；
   *  ③ 各种破折号/减号/下划线/间隔点/斜杠 → **统一成半角连字符 '-'**
   *     （— – ‒ ― − ﹣ _ · ・ ･ /）；
   *  ④ **连续连字符折叠成一个**，并去掉首尾多余的连字符；
   *  ⑤ 转小写。
   *  所以「灭世圣女——救世魔王」「灭世圣女 - 救世魔王」「灭世圣女－救世魔王」都等价于
   *  「灭世圣女-救世魔王」——AI/玩家怎么写都能匹配上。判定双方都过这道，比较才对称。 */
  function normName(s) {
    let t = toHalfWidth(s);
    t = t.replace(/[\s「」『』【】\[\]()（）"'’“”]/g, '');
    t = t.replace(/[—–‒―−﹣_·・･/]/g, '-');
    t = t.replace(/-+/g, '-');
    t = t.replace(/^-+|-+$/g, '');
    return t.toLowerCase();
  }
  /** 对象里是否存在该名字的键（归一后比较）。 */
  function hasNamed(obj, name) {
    if (!obj || typeof obj !== 'object') return false;
    const t = normName(name);
    return Object.keys(obj).some((k) => normName(k) === t);
  }

  // ---- 隐藏关（隐藏世界线事件）----------------------------------------------------------
  //
  //  机制总览（与 EJS 的分工）：
  //    · 随机在后端（前端脚本）里跑，**不进 EJS**：命中时只把"这一刻该怎么写"塞进进节点战报。
  //    · 命中时**变量不动** —— AI 尚不知道这条世界线，只按战报写这一节点。
  //    · 等那件收藏品真正到账（AI 写进 收藏品），前端扫到才把该变量 f→t：
  //        随机渠道关闭 + 由用户自建的 EJS 条目接管"这条世界线该怎么写"。
  //    · ⚠ 生命周期 = **本局进度**，不是长期收藏：收藏品与 $隐藏关 都属本局数据，
  //      通关/失败/熔断/开新局一律复位（见 _resetRunScopedDraft）。真正跨局保留的只有
  //      蚀刻章（含隐藏层闸门那枚「灭世圣女-救世魔王」）。所以 EJS 只能在**本局内**读到 t；
  //      换局后要靠蚀刻章（长期）重新走一遍前置，而不是靠这里的 t。
  //  互斥：
  //    · **族内**：族里任一变量转 t → 整个族的渠道关闭（不再掷骰）。
  //    · **族间**：互不影响，可叠加；但**同一节点最多触发一个**（没中选的那族本次不消耗）。
  const HIDDEN_FAMILIES = ['非特殊', '特殊'];
  const HIDDEN_EVENTS = [
    {
      id: '海嗣', 家族: '非特殊', 概率: 0.24, 优先级: 1,
      // 前置条件（空 = 不需要）
      前置蚀刻章: '', 前置收藏品: '',
      收藏品: { 名: '大群交触手', 描述: '这个时间线的人类已经没有未来了. 但它是个不错的性玩具', 值: -50, 标签: '未来' },
      此刻: '这是一个海嗣灭世的世界线：出场角色**必须**处在全面海嗣战争中，处于"反抗中"或"已被同化"的状态。'
        + '据此改写此间目标角色的处境与言行，不要写成和平日常。',
    },
    {
      id: '月光', 家族: '非特殊', 概率: 0.24, 优先级: 1,
      前置蚀刻章: '', 前置收藏品: '',
      收藏品: { 名: '白月光', 描述: '一团白花状的源石, ta们不再是悲剧, 但另外的ta们只会是悲剧', 值: -50, 标签: '过往' },
      此刻: '这是一条"白月光"式的歪斜世界线：出场角色**必须**严重偏离原设，'
        + '处在超规格的势力错位 / 身份错位 / 经历错位 / 历史大事件反转之中（她是另一种人生里的她，不是正史那个人）。'
        + '据此改写此间目标角色的处境与言行。',
    },
    {
      id: '特殊源石', 家族: '特殊', 概率: 0.12, 优先级: 2,
      // 前置：必须持有蚀刻章「灭世圣女-救世魔王」（名称匹配，归一后比较）。
      // 收藏品那一格留给以后（目前该事件本身就是产出 我要吃饭 的那一条，前置收藏品留空）。
      前置蚀刻章: '灭世圣女-救世魔王', 前置收藏品: '',
      收藏品: { 名: '我要吃饭', 描述: '一张桌布, 敲三下可以按心情召唤任何美食. 为什么它会出现在这里?', 值: 0, 标签: '' },   // 无效果：值 0 + 空标签 → 两个算值函数都会跳过
      此刻: '这是一条特殊源石全面蔓延的世界线：出场角色**必须**处于深度特殊源石感染中'
        + '（环境里遍布金黄的特殊源石，角色额头的结晶尤为巨大），'
        + '追随某位"圣女"（希尔达），向她传播的理念——拥抱矿石病、死亡毫无痛苦——身体力行。'
        + '据此改写此间目标角色的处境与言行。',
    },
  ];
  const HIDDEN_IDS = HIDDEN_EVENTS.map((e) => e.id);   // 供以后扩展/调试用

  // =========================================================================================
  // 【模块2：变量 I/O 层 —— 读写聊天/楼层变量 + 初始化 + 开发模式注入】
  // =========================================================================================
  // —— 背景图 ——
  // 【主城（游戏外）默认背景】罗德岛白舱走廊（1024×576 级的 banner，36 KB，image/webp）。
  //   原图在 GitHub 仓库 ll11292631-droid/mama 的 main 分支，这里走 jsDelivr（GitHub 直链在国内常被墙）。
  //   jsDelivr 的 GitHub 形态：https://<CDN 域>/gh/<用户>/<仓库>@<分支>/<路径>
  //   ⚠ CDN 域选的是 gcore：实测 cdn.jsdelivr.net / fastly.jsdelivr.net 都会 302 到
  //     raw.githubusercontent.com（墙内最常挂的域名，等于"加速"白做）；gcore 则重定向到
  //     gcore.jsdelivr.net 自己的 CDN，不绕回 GitHub。换了域名仍不通时，把下面这行换成
  //     https://raw.githubusercontent.com/ll11292631-droid/mama/main/60_g1_rhodescorridor_bc.webp 即可。
  //   ⚠ 仓库/分支/文件名三处必须与 GitHub 上完全一致；写错会静默 404（背景黑掉但不报错）。
  const HOME_BG_URL = 'https://gcore.jsdelivr.net/gh/ll11292631-droid/mama@main/60_g1_rhodescorridor_bc.webp';
  // 【主城打开过场的铺底图】= 原来那张主城背景（imgchest）。
  //   它不再当常驻背景，只在每次进主城时与标题文字一起"打个照面"再淡出（见 _playHomeSplash）。
  //   想去掉这段过场：把这里改成 '' 即可（HOME_BG_URL 不受影响）。
  const HOME_SPLASH_BG = 'https://cdn.imgchest.com/files/e608e3713619.jpg';
  const BgMap = {
    out_of_game: HOME_BG_URL,                                              // 游戏外 / 主城（常驻背景）
    preparation: 'https://cdn.imgchest.com/files/08c63ff8fb4e.jpg',        // 编队 / 标本库共用
    map_navigation: 'https://cdn.imgchest.com/files/5e4441702aa1.jpg',     // 地图 / 非战斗节点共用
    event_node: 'https://cdn.imgchest.com/files/5e4441702aa1.jpg',         // 不期而遇等（与地图共用）
    shop: 'https://cdn.imgchest.com/files/28ab5d8b254d.jpg',               // 诡意行商
  };
  // 注意：本对象不仅作"读默认值"，还作为 writeVars 的"回写白名单" —— 只有列在其中的顶层键
  // 才会被写回 stat_data。因此像 局内干员库/标本库/时间线记忆库/局内剧情日志 这类本局/长线数据
  // 必须在此声明默认值，否则 writeVars 不会持久化它们（这正是"战斗后干员被清空/局内干员库不见"的根因）。
  const CORE_VARS = {
    干员编队: {},
    敌方库: {},
    // 标本库（长线，AI 可见）：按时间线编号分组 —— { "<四位编号>": { "<干员名_编号>": 干员卡 } }
    //   组号由前端在通关 / 保存并禁用时写入；读取一律走模块作用域的 specFind/specKeys 等工具函数
    //   （见【模块2.8】后面的「标本库分组读取工具」），不要在这里手写两层遍历。
    标本库: {},
    收藏品: {},
    蚀刻章: {},
    玩家资源: { 核心生命: 10, 淫堕源石: 0, 精液: 0, 所知: 0, 已晋升干员: [] },
    行动: { 额外探索: false, 原定目标: '' },
    _长期总池: { 污染: { 未来: 0, 过往: 0, 现实: 0 }, 去量化: 0 },
    _探索进程: { $当前状态: 'out_of_game', $当前层数: 0, $当前位置: '未出发', $基底干员: '', $隐藏层: false, 当前时间节点: '未知', 当前互动对象: '', _晋升花费: promoteSentence(PROMOTE_COST_DEFAULT) },
    _全局资产: { 普瑞赛斯子宫液化储量: 0, 已解锁长期增益: {}, 首次通关标记: false },
    $切片: { $active: false, $status: 'out_of_game', $nodeData: null, $当前时间点: 1094, $当前敌方: '', $软硬: '硬', $原定角色: '', $收服基线: [], $额外收服完成: false, $变奏用尽: false, $锁定: false, $待定: false, $终局分支: '', $隐藏关: '' },
    $难度: { 档位: 1, 分队: '后勤分队' },
    // 短对局开关（纯前端）：真 = 层序只走 1→3→5（跳过 2/4 层）、三轴只衰减 2 次、敌池合并、
    //   第 5 层 boss 前补一个单独诡意行商、隐藏关概率 ×2。出发时由 _applyRunDifficulty 落值。
    //   ⚠ 必须登记在 CORE_VARS 里！writeVars 的差分回写只认 CORE_VARS 的顶层键，
    //     漏登记 = 写入被静默丢弃（变量永远停在 schema 的 prefault(false)）—— 已踩过。
    $短对局: false,
    $地图状态: { 层数: 1, 每列: [], 解锁列数: 1, 当前列: 0 },
    $衰减档: 0.8,
    $收藏品获得层: {},
    $隐藏关: { 海嗣: false, 月光: false, 特殊源石: false },
    // 存档库（纯前端区，AI 不可见）：{ "<四位随机编号>": { "年,月,日": 剧情内容 } }
    //   · 通关 / 存档并退出 时把本局剧情日志整段搬进来；开新局清空剧情日志时不动它。
    //   · 需要 AI 知情时由世界书 EJS 定点注入（读 _当前启用时间线 或 玩家消息里的编号）。
    $时间线记忆库: {},
    // 时间线的自定义名字（纯前端区，AI 不可见）：{ "<四位编号>": "名字" }
    //   · 界面行标题 = `#编号-名字`，名字缺省显示「未命名」；编号由归档分配，玩家不可改。
    //   · 只有名字、没有剧情也没有干员的时间线不会单独存在（行集合 = 记忆库编号 ∪ 标本库组号）。
    $时间线名称: {},
    // 当前启用（重玩中）的时间线编号（4 位数字字符串；'' = 没在重玩）。
    //   `_` 前缀 → AI 只读可见：让它知道"现在是重玩某条已通关世界线"，
    //   前端同时据它锁死 出门探索/难度/设基底/晋升/熔断。
    _当前启用时间线: '',
    // 剧情日志 = 本局流水（仅 `年,月,日` → 剧情内容）；每局开局清空，通关/存档时整段搬进 $时间线记忆库。
    剧情日志: {},
  };

  // ── MVU 原生可扩展标记（方案A）────────────────────────────────────────
  // MVU beta 的运行时 schema 是由 stat_data 数据派生的（generateSchema），节点 extensible
  // 只认三个来源：旧 schema 继承 / 数据上的 $meta.extensible / $meta.recursiveExtensible /
  // 父链递归。z.record / z.intersection 只影响 zod 校验桥（registerMvuSchema），进不了原生层。
  // 所以要让 敌方库/干员编队/标本库 这类"记录容器"天然可扩展（AI 用 json_patch insert 新角色卡
  // 不报"SCHEMA 违规：不可扩展"），必须在容器数据上一次性带 $meta：generateSchema 烘焙成
  // extensible:true 节点后，靠旧 schema 继承永久保持（此后 $meta 即使被清也不影响）。
  // 标记只在 writeVars 写回出口注入，读视图（readVars）统一剥掉，前端业务逻辑看不到。
  // 玩家资源 也在列：它全是固定标量键，本不需要扩展；但它底下的 `已晋升干员` 是**数组**——
  // MVU 的数组节点只从"父链 recursiveExtensible"或数组内的 $arrayMeta 元数据元素/$__META_EXTENSIBLE__$
  // 哨兵拿可扩展性（数组自己身上的 $meta 属性 MVU 根本不读）。AI 用自然语言晋升时会 `insert`
  // 该数组，父级不可扩展就报"SCHEMA 违规：无法向...不可扩展的数组写入元素"。
  // 把 玩家资源 一起开路后，extensible+recursiveExtensible 会向下继承，数组随之可扩展。
  // 标本库 本身就是**两层**（编号 → 干员卡）：父级 extensible 让 AI 能往已有编号组里 insert 新卡，
  // recursiveExtensible 再保证组这一层也能被补键（不改结构时 AI 用不到，但留着不亏）。
  // ⚠ `$时间线名称` **不进**本表：它纯前端写、AI 永远不写，故不需要 $meta 开路（读它时也就没有 $meta 要剥）。
  const CONTAINERS_WITH_META = ['干员编队', '敌方库', '标本库', '收藏品', '蚀刻章', '$时间线记忆库', '剧情日志', '玩家资源'];
  const CONTAINER_META = { extensible: true, recursiveExtensible: true };

  /**
   * MVU 楼层变量结构：唯一上级是 `stat_data`，下面直属各类游戏变量
   * （_探索进程 / _玩家资源 / 干员编队 / 标本库 ...），与 AI 读取的
   * {{format_message_variable::stat_data}} 对齐。display_data / delta_data 是 MVU 内部其它键，不动。
   */
  const VAR_OPT = { type: 'message', message_id: -1 };

  /** 读楼层 stat_data 并平铺成“可直接访问名字字段”的对象（带 CORE_VARS 默认兜底） */
  function readVars(win, type = 'message') {
    try {
      const opts = type === 'message' ? VAR_OPT : { type };
      const v = win.getVariables && win.getVariables(opts);
      const stat = (v && v.stat_data) || {};
      const out = { ...CORE_VARS };
      Object.keys(stat).forEach((k) => { out[k] = stat[k]; });
      // （方案A）读视图剥掉写路径注入的 $meta 可扩展标记，前端枚举容器键/取卡时看不到它
      CONTAINERS_WITH_META.forEach((k) => {
        const o = out[k];
        if (o && typeof o === 'object' && !Array.isArray(o) && o.$meta) {
          out[k] = { ...o };
          delete out[k].$meta;
        }
      });
      return out;
    } catch (e) {
      return { ...CORE_VARS };
    }
  }

  /**
   * 统一"写楼层 stat_data"：把 fn 施加后的平铺视图写回 stat_data 名下关键字段。
   * 所有游戏变量一律落 stat_data 内，AI 可读。
   *
   * 【差分写入 · 根治误清空】(唯一权威解释"空转后干员编队/全部变量被重置"的关键修复)：
   *   - 以 stat_data 既有值为基底，缺省才补 CORE_VARS 默认；
   *   - 回写时【只把 fn 实际改动过的顶层键】写回，其余顶层键一律保持 stat 原状（绝不外写）。
   *   这样 writeVars 只会把 fn 真正改动过的顶层键写回，在第 8200（MVU 时序 / 交互）下
   *   绝不会再把 stat 里已有的 干员编队 / 标本库 用空的默认值覆盖清空。
   */
  function writeVars(win, fn) {
    const w = win || window;
    if (!w.updateVariablesWith) return;
    w.updateVariablesWith((vars) => {
      const stat = (vars && vars.stat_data) || {};
      // 记录各 CORE_VARS 顶层键的改动前序列化快照（深串行，能感知子字段变化）
      const safeStr = (o) => { try { return JSON.stringify(o); } catch (e) { return String(o); } };
      const before = new Map();
      Object.keys(CORE_VARS).forEach((k) => before.set(k, safeStr(stat[k])));
      // 以 stat 为基底，缺省补默认
      const flat = { ...stat };
      Object.keys(CORE_VARS).forEach((k) => {
        if (typeof flat[k] === 'undefined' || flat[k] === null) flat[k] = JSON.parse(JSON.stringify(CORE_VARS[k]));
      });
      fn(flat);
      // 只回写被 fn 真正改动的顶层键；未改动的保持 stat 原状，杜绝误清空
      vars.stat_data = { ...stat };
      Object.keys(CORE_VARS).forEach((k) => {
        let finalVal = flat[k];
        // （方案A）记录容器写回时注入 $meta 可扩展标记（幂等：stat 已有则 diff 相等不重复写）。
        // 容器一旦带 $meta 进入 stat_data，下次 MVU reconcile 会把该 schema 节点烘焙成
        // extensible:true（recursiveExtensible 让容器下所有层级的对象都可扩展），此后 AI 往
        // 敌方库/干员编队/标本库 等 insert 任意新键不再报"SCHEMA 违规：不可扩展"。
        if (
          CONTAINERS_WITH_META.includes(k) &&
          finalVal && typeof finalVal === 'object' && !Array.isArray(finalVal)
        ) {
          finalVal = { ...finalVal, $meta: { ...CONTAINER_META } };
        }
        const nowJson = safeStr(finalVal);
        if (nowJson !== before.get(k)) vars.stat_data[k] = finalVal;
      });
      return vars;
    }, VAR_OPT);
  }

  /** 保证核心变量存在（开发模式/新存档用）：把所有 CORE_VARS 顶层键默认值真实落到 stat_data，
   *  这样 敌方库/蚀刻章/行动 等容器在 MVU stat_data 里真实存在；容器还会带上 $meta 可扩展标记
   *  （方案A），AI 用 json_patch insert 才不会报"父级不可扩展/SCHEMA 违规"。
   *  ⚠ 绝不在此处动 variables.schema：MVU 用 isMvuData（stat_data+schema 同时存在）判定楼层
   *  "变量有效"，任何让 schema 缺失的写入都会让该楼失去继承资格 → 下一楼 getLastValidVariable
   *  跳过它回退到更早楼层 → 静默"进度回退"（曾因此出现"收服成功却回退成未收服/节点回跳"）。
   *  清 schema 想换来的"下一次 reconcile 重建"收益远小于它带来的继承断链风险，禁止再引入。 */
  function ensureGameVars(win) {
    const draft = readVars(win);
    const need = (k, def) => { if (typeof draft[k] === 'undefined' || draft[k] === null) draft[k] = def; };
    Object.keys(CORE_VARS).forEach((k) => need(k, CORE_VARS[k]));
    // 上面只是改内存视图；真正落盘由 writeVars 的差分写出完成（flat 已含全部 CORE_VARS 默认值，
    // 与 stat 缺省键比对后会把这些顶层键补写进 stat_data，记录容器同时被注入 $meta）。
    writeVars(win, () => {});
  }

  // =========================================================================================
  // 【模块3：前端 UI 层 —— 状态机路由 + 各页面视图】
  // =========================================================================================
  const globalStyles = `

    * { box-sizing: border-box; }
    /* ===== 界面令牌（**桌面口径**：取值与改造前逐像素相同）=============================
       · 手机端紧凑档只改这几个令牌的**值**，规则在文件末尾 compactStyles，基础规则一律不动；
       · --bar-h     顶栏高度（#stage / #game-page / #node-stage / 各处 top 锚点都吃它）
       · --right-col 右侧竖列让位宽度（聊天面板 + 雷达 + 选项卡共用，原先 4 处各写各的）
       · --vh        iframe 实测 1% 高度，由 JS 写入；无 JS 时回退 1vh（桌面等价）
       · --fs-d      全站字号统一增量：桌面 0px，紧凑档 -2px（≤11px 极小字带下限保护）
       · --fs-dl     大字号（≥14px）**再**加一档：桌面 0px，紧凑档 -1px → 大字共 -3px；
                     小字（12/13px）只受 --fs-d 影响并保底 11px（避免"看不清"） */
    :root { --bar-h: 48px; --right-col: 260px; --vh: 1vh; --fs-d: 0px; --fs-dl: 0px; }
    body { margin: 0; padding: 0; width: 100vw; height: 100vh;
      /* dvh：移动端地址栏伸缩会改变可视高度，纯 vh 会算多 → 底部输入行被顶出屏幕。桌面两者相等。 */
      height: 100dvh; overflow: hidden;
      font-family: sans-serif; color: #fff; background-color: #101318;
      background-size: cover; background-position: center; background-attachment: fixed;
      -webkit-user-select: none; user-select: none; cursor: default; }
    #root { position: relative; width: 100vw; height: 100vh; height: 100dvh; }
    body.fullscreen #root { width: 100vw; height: 100vh; height: 100dvh; }
    /* ===== 顶栏：鹰角式扁平化 —— 无大色块，仅描边 + 角标字形 + 细分隔线，
       整条顶栏统一一套「深底 / 细边 / 亮字 / 悬停提亮」的按钮语汇；
       只有「退出游戏」保留红、「紧急熔断」保留琥珀，作危险操作的唯一警示色。 ===== */
    #top-bar { position: absolute; top: 0; left: 0; width: 100%; height: var(--bar-h);
      display: flex; align-items: center; padding: 0 14px;
      z-index: 100; gap: 8px; flex-wrap: wrap;
      background:
        linear-gradient(180deg, rgba(15,19,26,.96) 0%, rgba(8,10,14,.90) 100%),
        repeating-linear-gradient(90deg, rgba(255,255,255,.04) 0 1px, transparent 1px 7px);
      border-bottom: 1px solid rgba(151,178,216,.20);
      box-shadow: 0 1px 0 rgba(0,0,0,.5), 0 6px 18px rgba(0,0,0,.35); }
    #top-bar::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,214,138,.55), transparent);
      pointer-events: none; }
    .stat-item { font-size: calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)); color: #e4e9f1; font-weight: bold; margin: 0 12px 0 0;
      letter-spacing: .4px; text-shadow: 0 1px 3px rgba(0,0,0,.6); }
    .top-bar-center { display: flex; align-items: center; gap: 8px; }
    .top-drop { position: relative; overflow: hidden; border-radius: 6px; cursor: pointer;
      font-family: inherit; font-size: max(11px, calc(12px + var(--fs-d, 0px))); letter-spacing: .6px;
      padding: 6px 14px 6px 22px; color: #d9e0ea;
      background: linear-gradient(180deg, rgba(31,37,49,.78), rgba(18,22,30,.62));
      border: 1px solid rgba(151,178,216,.26);
      transition: color .16s, border-color .16s, background .16s, box-shadow .16s; }
    .top-drop:hover { color: #ffe6b0; border-color: rgba(255,210,92,.62); }
    .top-drop:active { background: rgba(255,210,92,.10); box-shadow: inset 0 0 12px rgba(255,210,92,.14); }
    /* 角标字形替代 ◇▣◈ 字符图标：既统一口径，又不用手写 SVG */
    .top-drop::before { content: '◆'; position: absolute; left: 9px; top: 50%;
      transform: translateY(-50%); font-size: max(7px, calc(7px + var(--fs-d, 0px))); color: rgba(255,210,92,.5); pointer-events: none; }
    #drop-roster::before { content: '■'; color: rgba(160,200,240,.5); }
    #drop-base::before { content: '▲'; color: rgba(140,220,200,.5); }
    .top-bar-center .top-drop + .top-drop { position: relative; }
    .top-bar-center .top-drop + .top-drop::after { content: ''; position: absolute; left: -4.5px; top: 50%;
      transform: translateY(-50%); width: 1px; height: 14px;
      background: rgba(151,178,216,.22); pointer-events: none; }
    #top-bar .top-btn { min-width: 74px; border-radius: 6px; cursor: pointer; font-family: inherit;
      font-size: max(11px, calc(12px + var(--fs-d, 0px))); font-weight: bold; letter-spacing: 1.2px; padding: 7px 16px;
      color: #ced6e2; background: linear-gradient(180deg, rgba(32,38,50,.72), rgba(19,23,31,.54));
      border: 1px solid rgba(151,178,216,.28); transition: .16s; }
    #top-bar .top-btn:hover { color: #eef3fa; border-color: rgba(180,205,235,.66);
      background: linear-gradient(180deg, rgba(45,53,68,.86), rgba(25,30,40,.74)); }
    #top-bar .top-btn:active { transform: translateY(1px); }
    #fullscreen-btn:hover { border-color: rgba(96,220,160,.70); color: #d8fff0; }
    /* 危险操作：唯二标色的两颗 —— 琥珀＝熔断（有损但可挽回），红＝退出（结束本局界面） */
    #emergency-btn { color: #ffd98c; border-color: rgba(250,173,20,.58);
      background: linear-gradient(180deg, rgba(250,173,20,.22), rgba(250,173,20,.07)); }
    #emergency-btn:hover { color: #ffe9bd; border-color: rgba(255,206,102,.95);
      background: linear-gradient(180deg, rgba(250,173,20,.34), rgba(250,173,20,.12));
      box-shadow: 0 0 14px rgba(250,173,20,.20); }
    #close-btn { color: #ffb4b6; border-color: rgba(255,77,79,.55);
      background: linear-gradient(180deg, rgba(255,77,79,.22), rgba(255,77,79,.07)); }
    #close-btn:hover { color: #ffdcdc; border-color: rgba(255,120,122,.95);
      background: linear-gradient(180deg, rgba(255,77,79,.34), rgba(255,77,79,.12));
      box-shadow: 0 0 14px rgba(255,77,79,.20); }
    #main-content { position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      display: flex; align-items: center; justify-content: center; flex-direction: column; }
    #stage { position: absolute; top: var(--bar-h); left: 0; right: 0; bottom: 28%; z-index: 2; }
    /* 底部聊天面板：左下角，只占「左起一大半宽」。右侧留出的 260px 是一条独立的竖列：
       下段给雷达(RADAR_W)、上段整段到顶栏都留给选项卡 —— 聊天框不再横贯整条底边。 */
    #chat-container { position: absolute; left: 0; right: var(--right-col); bottom: 0; height: 28%; z-index: 50;
      background: linear-gradient(to top,
        rgba(4,6,10,.88) 0%, rgba(4,6,10,.74) 34%, rgba(5,7,12,.46) 66%, rgba(5,7,12,.10) 88%, rgba(5,7,12,0) 100%);
      display: flex; flex-direction: column;
      border-top: 1px solid transparent;
      border-image: linear-gradient(to right, transparent, rgba(155,180,220,0.35), transparent) 1; }
    /* 〘展开/收起〙：贴住聊天面板顶边、靠左一大半让出右侧（玩家气泡/正文区）空间；
       未展开朝下、展开后朝上（方向由 JS 写 innerText 决定）。
       ⚠ 用 position:fixed + z-index:400，作为 #root 直接子级悬浮在最顶层：
       永远盖过 gal 层(200)/聊天面板(50)，任何状态下都点得到（曾经的"<gal>盖住按钮"bug）。 */
    #chat-expand { position: fixed; top: calc(var(--vh) * 100 - var(--vh) * 28 - 26px); left: 22%; transform: translateX(-50%);
      width: 68px; height: 26px; padding: 0; margin: 0; cursor: pointer; font-size: max(11px, calc(12px + var(--fs-d, 0px)));
      line-height: 1; color: #cfd8e6; font-family: inherit;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(180deg, rgba(30,36,48,.96), rgba(12,15,22,.94));
      border: 1px solid rgba(160,182,216,.42); border-bottom: none;
      border-radius: 9px 9px 0 0; box-shadow: 0 -4px 14px rgba(0,0,0,.55);
      opacity: .92; transition: opacity .16s, color .16s, border-color .16s, background .16s;
      z-index: 400; }
    #chat-expand::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px;
      border-radius: 9px 9px 0 0;
      background: linear-gradient(90deg, transparent, rgba(255,226,168,.55), transparent); }
    #chat-expand:hover { opacity: 1; color: #ffe0a0; border-color: rgba(255,210,92,.75);
      background: linear-gradient(180deg, rgba(45,52,68,.98), rgba(18,22,30,.96)); }
    /* 展开态：聊天面板升到 88% → 按钮跟着贴到新顶边 */
    #chat-container.expanded ~ #chat-expand { top: calc(var(--vh) * 100 - var(--vh) * 88 - 26px); }
    /* 隐藏滚动条（保留滚动） */
    #chat-history::-webkit-scrollbar, #options-container::-webkit-scrollbar {
      width: 0; height: 0; background: transparent; }
    #chat-history, #options-container { scrollbar-width: none; -ms-overflow-style: none; }
    #chat-history { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 18px 10px; display: flex;
      flex-direction: column; gap: 9px; }
    .chat-msg { display: flex; flex-direction: column; max-width: 78%; position: relative; }
    .chat-msg.user { align-self: flex-end; align-items: flex-end; }
    .chat-msg.ai { align-self: flex-start; align-items: flex-start; }
    .chat-name { font-size: max(11px, calc(11px + var(--fs-d, 0px))); color: #999; padding: 0 4px; margin-bottom: 2px; }
    /* ===== 聊天记录（展开态）=====
       ⚠ 正文已经搬到独立 Galgame 窗口（见下方 #gal-layer）。
       这里只剩两件事：① 收起态不显示任何正文（窗口负责显示）；
       ② 展开态显示完整对话记录（含 🔄🗑️ 消息级按钮）。
       所以 .chat-msg / .chat-bubble 的视觉只在展开态生效。 */
    .chat-bubble { font-size: calc(14.5px + var(--fs-d, 0px) + var(--fs-dl, 0px)); }
    /* 收起态：正文/名字全部让位给 Galgame 窗口，只剩一个空的输入条容器 */
    #chat-container:not(.expanded) #chat-history { opacity: 0; pointer-events: none; }
    #chat-history { transition: opacity .25s ease; }
    .chat-msg { z-index: 5; }
    /* Galgame 段落容器：一段一屏，不再需要组内滚动条 */
    .gal-grp { max-height: 42vh; }
    /* 黄色推进箭头：仅在"输出中 / 还有下一组"时出现 */
    #gal-arrow { position: absolute; right: 16px; bottom: calc(100% - 100%); margin-bottom: 58px;
      font-size: max(11px, calc(13px + var(--fs-d, 0px))); color: #ffd25c; opacity: 0; pointer-events: none;
      text-shadow: 0 0 8px rgba(255,210,92,.7); transition: opacity .2s; z-index: 4; }
    #gal-arrow.on { opacity: .95; pointer-events: auto; cursor: pointer;
      animation: galBob 1s ease-in-out infinite; }
    @keyframes galBob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(4px); } }

    /* =========================================================================
       〘独立 Galgame 窗口〙#gal-layer
       与原聊天框是两个东西：原聊天框降级成「输入条 + 可展开的对话记录」，
       正文（翻页 / 名牌 / 头像）全部搬到这一层。
       层级：node-hud 300 / option-rail 250 → 本层 200 会落在选项栏与细 HUD 之下。
       ⚠ 让位规则（与 #chat-container 完全同一口径）：
         · bottom: 58px —— 让出底部输入行，输入框/发送/停止按钮不被压住；
         · right: 260px —— 让出右侧竖列（雷达 + 选项栏），雷达不被压暗。
       ========================================================================= */
    #gal-layer { position: fixed; left: 0; right: var(--right-col); bottom: 58px;
      height: calc(var(--vh) * 34); min-height: 200px; z-index: 200; display: none;
      /* ⚠ 本层是个"空盒子"，会盖在聊天面板展开按钮(#chat-expand, top:-26px)上方——
         必须让整层不接收指针事件，否则按钮会被它吃掉（点了完全没反应）。
         真正需要点击的只有对话框本体 #gal-box，见它的 pointer-events: auto。 */
      pointer-events: none; }
    /* !important：防止任何来源（如被挪进 flex 容器）把 display 压回 none，导致"看不见窗口" */
    #gal-layer.on { display: block !important; }
    /* ── 玩家最后一条发言气泡：贴着对话框「上边缘」靠右悬浮，内容变长时向上拉伸 ──
        bottom:100% → 气泡底边正好贴住 gal 对话框(#gal-box)上沿，不再悬在窗口顶之上；
        flex 列以底边为锚，内容越多整体越高。内容实时取聊天最后一条 user 消息（已剪除系统战报）。 */
    #gal-float { position: absolute; right: 30px; bottom: 100%; z-index: 3;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      max-width: 62%; pointer-events: none; }
    #gal-float .gal-you { display: inline-block; padding: 7px 13px; font-size: max(11px, calc(13px + var(--fs-d, 0px))); line-height: 1.5;
      color: #dbe7f7; letter-spacing: .3px;
      background: linear-gradient(180deg, rgba(30,44,68,.94), rgba(18,26,40,.94));
      border: 1px solid rgba(120,170,230,.45); border-right: 3px solid #5a8acf; border-radius: 9px;
      box-shadow: 0 6px 20px rgba(0,0,0,.55); max-height: 4.6em; overflow: hidden; text-overflow: ellipsis; }
    #gal-float .gal-you::before { content: '玩家 · '; color: #7fa8dc; font-size: max(11px, calc(11px + var(--fs-d, 0px))); letter-spacing: 1px; }
    #gal-float .gal-you.off { display: none; }

    /* ---- 对话窗主体：贴底通栏 ---- */
    /* 对话窗本体：既是视觉底（渐变让正文可读），也是**点击翻页的唯一热区**——
       热区与所见对话框严格重合，不会再"点到框外也翻页"或"框内点不动"。 */
    #gal-box { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; padding: 0 0 12px;
      cursor: pointer; border-radius: 10px 10px 0 0;
      /* 整层 pointer-events:none，只有对话框本体重新接管指针事件 */
      pointer-events: auto;
      background: linear-gradient(to top,
        rgba(4,6,10,.92) 0%, rgba(4,6,10,.80) 34%, rgba(5,7,12,.50) 68%,
        rgba(5,7,12,.16) 88%, rgba(5,7,12,0) 100%);
      border-top: 1px solid rgba(150,175,215,.18); }
    /* ⑵ 角色名牌：坐在对话窗左上角、压在边框外面 */
    #gal-name { position: absolute; left: 132px; top: -15px; z-index: 4;
      min-width: 96px; max-width: 46%; padding: 4px 16px; font-size: max(11px, calc(13px + var(--fs-d, 0px))); font-weight: bold;
      letter-spacing: 1.2px; color: #ffe6b0; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; text-align: center;
      background: linear-gradient(180deg, rgba(34,40,54,.98), rgba(16,20,28,.96));
      border: 1px solid rgba(255,210,92,.45); border-radius: 7px;
      box-shadow: 0 4px 14px rgba(0,0,0,.6); }
    #gal-name.off { display: none; }
    /* ⑶ 头像：对话框左内侧；抬高一段，把底部让给左右两个翻页箭头 */
    #gal-avatar { display: none; position: absolute; left: 20px; bottom: 56px; z-index: 3;
      width: 92px; height: 92px; object-fit: cover; object-position: top center; border-radius: 8px;
      background: rgba(8,10,14,.8); border: 1px solid rgba(150,170,210,.38);
      box-shadow: 0 6px 18px rgba(0,0,0,.6); pointer-events: none; }
    #gal-avatar.on { display: block; }
    /* ⑷ 正文区：正文左边界给头像让位；"一页一屏"由脚本整页切换 */
    #gal-body { position: relative; margin: 0 24px; padding: 26px 20px 12px 132px;
      min-height: 150px; font-size: calc(15px + var(--fs-d, 0px) + var(--fs-dl, 0px)); line-height: 1.78; color: #eef2f8;
      text-shadow: 0 2px 6px rgba(0,0,0,.85); white-space: pre-wrap; word-break: break-word; }
    #gal-body .gal-head { font-size: 1.1em; font-weight: bold; color: #ffd98c; }
    #gal-body .gal-quote { color: #c3ccda; border-left: 2px solid rgba(150,175,215,.5); padding-left: 10px; }
    #gal-body p { margin: 0 0 6px; }
    #gal-body p:last-child { margin: 0; }
    /* 超长段落页内可滚动兜底（不参与翻页） */
    #gal-body .gal-grp { max-height: 30vh; overflow-y: auto; scrollbar-width: thin; padding-right: 6px; }
    /* ⑸ 翻页箭头组：左下「上一页」/ 右下「下一页」，都在头像下方；第 1 页藏 ←、末页藏 → */
    #gal-back, #gal-next { position: absolute; bottom: 10px; z-index: 4; width: 30px; height: 30px;
      display: flex; align-items: center; justify-content: center; font-size: max(11px, calc(13px + var(--fs-d, 0px)));
      color: #ffd25c; text-shadow: 0 0 10px rgba(255,210,92,.75);
      background: rgba(10,13,18,.55); border: 1px solid rgba(255,210,92,.35); border-radius: 7px;
      opacity: .3; transition: opacity .2s; pointer-events: none; cursor: pointer; user-select: none; }
    #gal-back.on, #gal-next.on { opacity: .95; pointer-events: auto; animation: galBob 1s ease-in-out infinite; }
    #gal-back { left: 22px; }
    #gal-next { right: 30px; }
    /* 页角标（第 3/7 页）：居中悬在箭头之上 */
    #gal-pager { position: absolute; left: 50%; transform: translateX(-50%); bottom: 14px; z-index: 4;
      font-size: max(11px, calc(11px + var(--fs-d, 0px))); letter-spacing: 2px; color: rgba(190,205,225,.7);
      text-shadow: 0 1px 4px rgba(0,0,0,.8); pointer-events: none; }
    @media (max-width: 900px) {
      #gal-layer { height: 40vh; }
      #gal-body { padding-left: 104px; padding-right: 10px; margin: 0 12px;
        font-size: calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)); }
      #gal-avatar { width: 72px; height: 72px; left: 12px; bottom: 44px; }
      #gal-name { left: 98px; }
      #gal-float { max-width: 84%; right: 12px; }
      #gal-back { left: 12px; bottom: 8px; }
      #gal-next { right: 12px; bottom: 8px; }
      #gal-pager { bottom: 12px; }
    }
    /* 窄屏：右列（雷达 200px）变窄 → 与 #chat-container 同步改成 216px，保持同一让位口径 */
    @media (max-width: 760px) {
      #gal-layer { right: 216px; }
    }

    /* =========================================================================
       〘立绘同台层〙#portrait-stage
       介于背景（#stage z2）与聊天框（#chat-container z50 / #gal-layer z200）之间，
       底部略微嵌入聊天框（--ps-overlap）→ 利用聊天框顶部渐淡自然过渡。
       水平基准 = 聊天框宽度（left:0 ~ right:var(--right-col)，与 #chat-container 同一口径）。
       大小：默认小号（顶部比大号低16%）；.large（目前仅薇薇安娜）顶到顶边栏。
       变暗：JS 按明暗指针给槽挂 lit/dim 类，用 .ps-slot.dim img { filter:brightness(.8) }——
             滤镜只压暗图片**有颜色的像素**（等效叠底），透明留白不动，且随图片内容走。
       渐淡：mask-image 作用在**内容即盒子**的 img 上（width:auto 随图片真实比例收窄），
             四周淡出只落在图片内容上，必定可见；不再用实体黑幕叠层。
       换位：槽位固定（ps-a 左 / ps-b 右），换人只切明暗、绝不重排左右。
       ========================================================================= */
    :root { --ps-overlap: 30px; }   /* 立绘底部嵌入聊天框的深度（占位可调：太大挡胯部，太小无过渡） */
    #portrait-stage { position: fixed; left: 0; right: var(--right-col); z-index: 45;
      /* ⚠ z-index 必须 ≥41 且 <50：低于 #node-stage(40) 会被节点背景整层盖住（头像/名牌正常但立绘不可见），
         高于 #chat-container(50)/#gal-layer(200) 则无法实现“底部嵌入聊天框”。
         实际 bottom/height 由 JS 的 _psLayout() 实测覆盖（见 _galLayout 尾部）。 */
      bottom: calc(var(--vh) * 34 + 58px + var(--ps-overlap));
      height: calc(var(--vh) * 100 - var(--bar-h) - var(--vh) * 34 - 58px - var(--ps-overlap));
      pointer-events: none; display: none; }
    #portrait-stage.on { display: block; }
    .ps-slot { position: absolute; bottom: 0; width: 42%; height: 88.2%; /* 默认档：宽度/高度整体 +5%（40%→42%、84%→88.2%） */
      opacity: 0; transition: opacity .35s ease, filter .35s ease; pointer-events: none; }
    .ps-slot.large { height: 99.75%; }                                  /* 大号：95% → 99.75%（+5%，顶到顶边栏下缘） */
    .ps-slot.small { height: 80.85%; }                                  /* 小号：77% → 80.85%（+5%，底边不动） */
    .ps-slot.on { opacity: 1; }
    /* img 铺满槽位盒(object-fit:contain 先行兜底)，加载完成后由 JS 把元素盒精确缩到内容盒，
       保证 mask 渐淡沿内容边缘、内容在槽内水平居中（不偏不缩图）。 */
    .ps-slot img { display: block; position: absolute; left: 50%; transform: translateX(-50%); bottom: 0;
      width: 100%; height: 100%; object-fit: contain; object-position: bottom center; z-index: 0; }
    /* 变暗=滤镜：只压暗有颜色像素（等效叠底），透明留白不动；lit 槽不挂 dim → 全亮度＝“谁说话谁亮” */
    .ps-slot.dim img { filter: brightness(.8); }
    /* 全暗态：本段无指向角色（{} 锚点为空/不匹配）→ 台上立绘全部压暗，等下次出现角色名再点亮 */
    #portrait-stage.noactive .ps-slot img { filter: brightness(.5) !important; }
    /* 四周渐淡：**多方向线性**（上下 4%、左右 3% 的小羽化带），各层 intersect 求交后只裁边缘；
       不做圆形羽化（用户拍板）。img 元素盒已被 JS 缩成内容盒，淡出沿内容边缘。 */
    .ps-slot img {
      -webkit-mask-image:
        linear-gradient(to bottom, transparent 0%, black 4%),
        linear-gradient(to top, transparent 0%, black 4%),
        linear-gradient(to right, transparent 0%, black 3%),
        linear-gradient(to left, transparent 0%, black 3%);
      -webkit-mask-composite: source-in;
      mask-image:
        linear-gradient(to bottom, transparent 0%, black 4%),
        linear-gradient(to top, transparent 0%, black 4%),
        linear-gradient(to right, transparent 0%, black 3%),
        linear-gradient(to left, transparent 0%, black 3%);
      mask-composite: intersect;
    }
    /* 单人：首名角色（ps-a）以聊天框宽度居中，不复用双人位置 */
    #portrait-stage.single #ps-a { left: 50%; transform: translateX(-50%); }
    /* 双人：槽位位置固定（ps-a 左、ps-b 右），贴近聊天框边缘（1.5% 微留白）；只切明暗不换位 */
    #portrait-stage.dual #ps-a { left: 1.5%; }
    #portrait-stage.dual #ps-b { right: 1.5%; }
    @media (max-width: 900px) {
      #portrait-stage { bottom: calc(var(--vh) * 40 + 58px + var(--ps-overlap));
        height: calc(var(--vh) * 100 - var(--bar-h) - var(--vh) * 40 - 58px - var(--ps-overlap)); }
    }

    /* 玩家最后一条发言的悬浮气泡已搬到 #gal-float / #gal-you（见上方独立窗口段） */
    /* 聊天「更多历史」按钮：置顶居中，点击加载更早楼层 */
    .chat-more-btn { align-self: center; margin: 6px 0; padding: 6px 14px; font-size: max(11px, calc(12px + var(--fs-d, 0px)));
      color: #bcd7ff; background: rgba(43,90,143,0.35); border: 1px solid rgba(150,180,230,0.4);
      border-radius: 14px; cursor: pointer; transition: 0.15s; }
    .chat-more-btn:hover { border-color: #ffd25c; color: #ffe3a0; background: rgba(60,70,90,0.5); }
    /* 前端弹窗 modal（替代浏览器 alert/confirm 网页通知） */
    .modal-overlay { position: fixed; inset: 0; z-index: 99999; background: rgba(8,10,14,0.72);
      display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); }
    .modal-box { background: rgba(24,27,34,0.98); border: 1px solid rgba(150,180,230,0.4);
      border-radius: 12px; padding: 20px 24px; max-width: 420px; width: 90%; color: #eee;
      box-shadow: 0 16px 40px rgba(0,0,0,0.6); }
    .modal-title { font-size: calc(15px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; color: #ffd98c; margin-bottom: 10px; }
    .modal-body { font-size: max(11px, calc(13px + var(--fs-d, 0px))); line-height: 1.6; color: #d5dae3; white-space: pre-wrap;
      word-wrap: break-word; max-height: 55vh; overflow-y: auto; }
    /* 文本输入弹窗（_uiPrompt）：改名等单行输入 */
    .modal-input { width: 100%; margin-top: 10px; padding: 7px 10px; box-sizing: border-box;
      font-family: inherit; font-size: max(12px, calc(14px + var(--fs-d, 0px))); color: #ffe9b8;
      background: rgba(9,11,16,.9); border: 1px solid rgba(255,210,92,.55); border-radius: 6px; outline: none; }
    .modal-input::placeholder { color: #6f7887; }
    .modal-btns { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
    .modal-btn { padding: 8px 18px; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: max(11px, calc(13px + var(--fs-d, 0px))); }
    .modal-btn.ok { background: #2b5a8f; color: #fff; }
    .modal-btn.ok:hover { background: #3670b0; }
    .modal-btn.cancel { background: #4a2a2a; color: #ffb0b0; border: 1px solid #8a4a4a; }
    .modal-btn.cancel:hover { background: #5a3535; }
    /* 字号已在上方 Galgame 段统一放大到 14.5px（+11%），此处不再重复声明 font-size */
    .chat-bubble { padding: 9px 14px; border-radius: 12px; line-height: 1.62;
      word-wrap: break-word; position: relative; }
    .chat-msg.user .chat-bubble { background: rgba(43,90,143,0.85); color: #fff; border-bottom-right-radius: 2px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
    .chat-msg.ai .chat-bubble { background: rgba(36,40,52,0.7); color: #e8e6e0; border-bottom-left-radius: 2px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.25); border: 1px solid rgba(140,160,200,0.15); }
    .chat-bubble p { margin: 0 0 6px; }
    .chat-bubble p:last-child { margin: 0; }
    .chat-bubble .md-head { font-size: 1.12em; font-weight: bold; color: #ffd98c; }
    .chat-bubble .md-quote { color: #b9c2d0; border-left: 2px solid #556; padding-left: 8px; }
    .msg-controls { position: absolute; top: -14px; display: flex; gap: 2px; background: rgba(0,0,0,0.6);
      padding: 2px 4px; border-radius: 4px; opacity: 0; transition: 0.2s; z-index: 10; }
    .chat-msg:hover .msg-controls { opacity: 1; }
    .chat-msg.user .msg-controls { left: 0; }
    .chat-msg.ai .msg-controls { right: 0; }
    .ctrl-btn { background: none; border: none; color: #ccc; cursor: pointer; font-size: max(11px, calc(11px + var(--fs-d, 0px))); padding: 2px 4px; }
    .ctrl-btn:hover { color: #fff; background: #333; border-radius: 3px; }
    .ctrl-btn.danger:hover { color: #ff5566; }
    #chat-input-area { display: flex; align-items: center; gap: 8px; padding: 13px 14px;
      background: linear-gradient(180deg, rgba(6,8,12,.30), rgba(4,6,10,.62));
      border-top: 1px solid rgba(42,46,56,0.5); }
    #target-selector { background: #22242b; color: #ccc; border: 1px solid #3a3f4a; border-radius: 5px;
      padding: 6px 8px; font-size: max(11px, calc(12px + var(--fs-d, 0px))); max-width: 132px; }
    #chat-input { flex: 1; background: #181a20; color: #eee; border: 1px solid #3a3f4a; border-radius: 6px;
      padding: 8px 12px; font-size: max(11px, calc(13px + var(--fs-d, 0px))); outline: none; }
    #chat-input:focus { border-color: #5a8acf; }
    #chat-send { background: #2b5a8f; color: #fff; border: none; border-radius: 6px; padding: 8px 16px;
      cursor: pointer; font-weight: bold; }
    #chat-send:hover { background: #3670b0; }
    /* 〖中止思考按钮〗：平常锁定(✋)；AI 思考中变「中止」+ 加载转圈 */
    #chat-stop { background: #7a2a2a; color: #fff; border: 1px solid #a04a4a; border-radius: 6px;
      padding: 8px 10px; cursor: pointer; font-weight: bold; display: inline-flex; align-items: center; gap: 5px; }
    #chat-stop:disabled { opacity: 0.45; cursor: not-allowed; }
    /* 〖重roll按钮〗：输入框旁、中止按钮左边；AI 回复不满意时一键重生成 */
    #chat-reroll { background: #2f3a4e; color: #cdd9ea; border: 1px solid #4a5a74; border-radius: 6px;
      padding: 8px 10px; cursor: pointer; font-weight: bold; font-size: calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)); line-height: 1;
      display: inline-flex; align-items: center; }
    #chat-reroll:hover { color: #ffe0a0; border-color: rgba(255,210,92,.65); background: #3a4760; }
    #chat-reroll:disabled { opacity: 0.45; cursor: not-allowed; }
    .spinner { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,0.35);
      border-top-color: #fff; border-radius: 50%; display: inline-block;
      animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* 窄屏手机：输入行换行排列，按钮不许把输入框挤到屏幕外 */
    @media (max-width: 640px) {
      #chat-input-area { flex-wrap: wrap; }
      #chat-input { min-width: 100%; order: -1; }
      #chat-input-area select { max-width: 45%; }
      #chat-reroll { padding: 8px 12px; }
    }
    /* 结构化选项区 */
    #options-container { display: flex; flex-wrap: wrap; gap: 8px; padding: 6px 12px; max-height: 90px;
      overflow-y: auto; border-bottom: 1px solid #2a2e38; }
    .option-chip { background: #23262f; border: 1px solid #4a5060; color: #ddd; padding: 6px 12px;
      border-radius: 16px; cursor: pointer; font-size: max(11px, calc(12px + var(--fs-d, 0px))); transition: 0.15s; }
    .option-chip:hover { border-color: #ffd25c; background: #2e3240; }
    .option-chip.primary { border-color: #2b5a8f; color: #bcd7ff; }
    /* ===== AI 生成中（中止态）：动作封锁 =====
       凡会「改进程/修改变量/触发回复/填充 user 输入」的按钮一律禁止点击+置灰；
       纯阅读操作（档案/聊天记录/收藏品库/翻页/全屏/关闭）不受影响；
       中止按钮 #chat-stop 必须保持可点，故不在封锁之列。 */
    body.is-generating #chat-send,
    body.is-generating #chat-reroll,
    body.is-generating #drop-base,
    body.is-generating #emergency-btn,
    body.is-generating #ov-do,
    body.is-generating #pg-promote,
    body.is-generating #prep-start,
    body.is-generating .opt-card,
    body.is-generating .option-chip,
    body.is-generating .promote-btn { pointer-events: none; opacity: .45; filter: saturate(.6); }
    /* 战斗门：作战节点收服主目标前锁定「设基底」（与离开门控同口径 _nodeCanLeave；由 _syncBaseGateBtn 切换） */
    #drop-base.gate-locked { opacity: .45; pointer-events: none; }
    /* 占位 / 通用按钮 */
    .big-btn { padding: 16px 28px; font-size: calc(20px + var(--fs-d, 0px) + var(--fs-dl, 0px)); border: none; border-radius: 6px;
      cursor: pointer; font-weight: bold; box-shadow: 0 4px 15px rgba(0,0,0,0.4); }
    .btn-red { background: #ff4d4f; color: #fff; }
    .btn-gray { background: #444; color: #fff; border: 2px solid #888; }
    .btn-gold { background: #faad14; color: #111; }
    .view-panel { background: rgba(30,30,35,0.9); border: 1px solid #555; border-radius: 10px;
      padding: 24px; text-align: center; max-width: 640px; min-width: 320px; }
    .view-panel h2 { margin: 0 0 8px; }
    .view-panel p { color: #ccc; font-size: calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)); line-height: 1.6; }
    .row { display: flex; gap: 12px; justify-content: center; margin-top: 16px; flex-wrap: wrap; }
    /* 开发者模式面板 */
    #dev-panel { margin-top: 18px; border-top: 1px dashed #666; padding-top: 12px;
      background: rgba(0,0,0,0.35); border-radius: 8px; padding: 12px; }
    #dev-panel h3 { margin: 0 0 8px; color: #faad14; font-size: calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)); }
    .dev-btn { background: #2a2a2f; border: 1px solid #777; color: #eee; padding: 8px 14px;
      cursor: pointer; border-radius: 5px; font-size: max(11px, calc(13px + var(--fs-d, 0px))); }
    .dev-btn:hover { background: #3a3a44; }
    #dev-panel { max-width: 860px; }
    /* ---- 地图（弹性自适应，内容不缩放，容器横滚） ---- */
    .map-scroll { position: relative; width: 100%; max-width: 100%; overflow-x: auto; overflow-y: hidden;
      scrollbar-width: none; -ms-overflow-style: none; }
    .map-scroll::-webkit-scrollbar { width: 0; height: 0; background: transparent; }
    .map-inner { position: relative; display: flex; align-items: center; gap: 180px;
      padding: 40px; width: max-content; min-width: max-content; }
    /* ☆ 调整：节点上下间距再缩小（40px→30px→20px，约 -33%）；列间左右间距加大 50%（120→180px） */
    .map-col { display: flex; flex-direction: column; gap: 20px; align-items: center; flex-shrink: 0; }
    .map-node { position: relative; width: 180px; height: 180px; display: flex;
      flex: 0 0 auto; align-items: center; justify-content: center; cursor: pointer;
      transition: transform 0.18s ease, filter 0.18s ease; }
    .map-node img { width: 100%; height: 100%; object-fit: contain; pointer-events: none;
      display: block; }
    .map-node:hover { transform: scale(1.06); }
    .map-node.selected { filter: brightness(1.2); }
    .map-node.locked { pointer-events: none; filter: grayscale(1); opacity: 0.55;
      cursor: not-allowed; }
    .map-node.passed { pointer-events: none; filter: brightness(0.6) saturate(0.85);
      cursor: not-allowed; }
    /* 节点连接弧线箭头：覆盖整个地图，箭头贴真实节点坐标 */
    .map-links { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 5; }

    /* ===================================================================
       节点确认栏（#node-confirm）：点地图节点后从**屏幕右缘**滑入，
       与地图同时可见；左缘渐淡（参考图的排版语汇），右缘贴屏。
       · 下边缘停在「聊天条 / 三轴雷达」上方（28% + 10px），不盖住它们。
       · 标题不再是"图标方块"：一条**左缘硬切、向右线性减淡**的色条，标题压在它的尾段上。
       · 每种节点一套颜色：作战紫 / 紧急作战红 / 险路恶敌洋红 / 安全屋蓝 /
         不期而遇青 / 闲暇娱乐青绿 / 诡意行商绿（--nc-c 是色条主色，--nc-accent 是其余点缀色）。
       =================================================================== */
    #node-confirm {
      --nc-c: 168, 118, 255;                 /* 色条主色（作战=紫） */
      --nc-accent: 168, 118, 255;            /* 点缀色：INFO 标签 / 干员框 / 出发前往 */
      /* 高度 = 内容高度（下限 min-height，上限 max-height）：
         绝不再拉伸到底部去盖聊天条/三轴雷达；下边缘稳定停在屏幕 40% 附近。 */
      position: fixed; right: 0; top: calc(var(--bar-h) + 8px); bottom: auto;
      min-height: 38vh; max-height: calc(70% - var(--bar-h));
      width: min(420px, 42vw); min-width: 268px; z-index: 96;
      display: flex; flex-direction: column; gap: 10px;
      padding: 14px 16px 14px 30px; box-sizing: border-box; overflow-y: auto;
      scrollbar-width: thin; scrollbar-color: rgba(150,170,210,.3) transparent;
      background: linear-gradient(to right,
        rgba(8,10,14,0) 0%, rgba(8,10,14,.72) 12%, rgba(10,13,18,.94) 34%, rgba(10,13,18,.97) 100%);
      pointer-events: auto; animation: ncIn .22s ease-out both;
    }
    /* 配色（各节点类型） */
    #node-confirm.nc-a-red { --nc-c: 235, 74, 74; --nc-accent: 235, 74, 74; }
    #node-confirm.nc-a-magenta { --nc-c: 214, 82, 172; --nc-accent: 214, 82, 172; }
    #node-confirm.nc-a-blue { --nc-c: 74, 132, 234; --nc-accent: 74, 132, 234; }
    #node-confirm.nc-a-cyan { --nc-c: 62, 196, 190; --nc-accent: 62, 196, 190; }
    #node-confirm.nc-a-teal { --nc-c: 84, 198, 158; --nc-accent: 84, 198, 158; }
    #node-confirm.nc-a-green { --nc-c: 74, 190, 110; --nc-accent: 74, 190, 110; }
    @keyframes ncIn { from { opacity: 0; transform: translateX(46px); } to { opacity: 1; transform: none; } }
    #node-confirm.out { animation: ncOut .18s ease-in both; pointer-events: none; }
    @keyframes ncOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: translateX(40px); } }
    /* 标题头：色条在底层，标题文字压在色条的渐淡尾段上（"旁边略有重叠"） */
    .nc-head { position: relative; display: flex; align-items: center; min-height: 52px; margin-bottom: 2px; }
    .nc-band { position: absolute; left: 0; top: 0; bottom: 0; width: 62%; pointer-events: none;
      /* 左缘硬切（最左就是满色），向右线性减淡到透明；上下边缘也硬 —— 就是一块矩形渐变色条 */
      background: linear-gradient(to right,
        rgba(var(--nc-c), .92) 0%, rgba(var(--nc-c), .78) 26%, rgba(var(--nc-c), .30) 64%, rgba(var(--nc-c), 0) 100%); }
    .nc-title { position: relative; display: flex; flex-direction: column; justify-content: center;
      margin-left: clamp(34px, 24%, 104px); min-width: 0; color: #f7f9fc; font-weight: bold; letter-spacing: 2px;
      font-size: max(15px, calc(21px + var(--fs-d, 0px) + var(--fs-dl, 0px)));
      text-shadow: 0 2px 12px rgba(0,0,0,.72); white-space: nowrap; }
    .nc-title i { font-style: normal; display: block; margin-top: 4px; color: rgba(var(--nc-c), .98);
      font-weight: 400; letter-spacing: 4px; font-size: max(9px, calc(10px + var(--fs-d, 0px))); }
    .nc-info { display: flex; align-items: flex-start; gap: 8px; color: #c8d0dc; line-height: 1.7;
      font-size: max(11px, calc(12px + var(--fs-d, 0px))); }
    .nc-info-tag { flex: 0 0 auto; margin-top: 2px; padding: 0 5px; border-radius: 2px; letter-spacing: 1px;
      font-size: max(9px, calc(9px + var(--fs-d, 0px))); color: #0b0f14;
      background: rgba(var(--nc-c), .85); }
    /* 主战干员选择框（= 顶栏「主战干员」按钮的等价物，点它开同一个选择窗） */
    .nc-base { display: flex; align-items: center; gap: 10px; padding: 9px 11px; cursor: pointer;
      border-radius: 8px; background: rgba(255,255,255,.045);
      border: 1px solid rgba(var(--nc-accent), .34); transition: border-color .15s, background .15s; }
    .nc-base:hover { border-color: rgba(var(--nc-accent), .8); background: rgba(var(--nc-accent), .1); }
    .nc-base-ava { flex: 0 0 40px; width: 40px; height: 40px; border-radius: 6px; overflow: hidden;
      background: rgba(8,10,14,.7); border: 1px solid rgba(var(--nc-accent), .35); }
    .nc-base-ava img { width: 100%; height: 100%; object-fit: contain; }
    .nc-base-txt { flex: 1 1 auto; min-width: 0; }
    .nc-base-cap { display: block; color: #8f99a8; letter-spacing: 1px;
      font-size: max(9px, calc(10px + var(--fs-d, 0px))); }
    .nc-base-nm { display: block; color: #eef3fa; font-weight: bold; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; font-size: max(12px, calc(14px + var(--fs-d, 0px))); }
    .nc-base-nm.empty { color: #7b8595; font-weight: normal; }
    .nc-base-arrow { flex: 0 0 auto; color: rgba(var(--nc-accent), .9);
      font-size: max(11px, calc(13px + var(--fs-d, 0px))); }
    .nc-spacer { flex: 1 1 auto; min-height: 4px; }
    .nc-go { flex: 0 0 auto; align-self: flex-end; cursor: pointer; padding: 10px 22px; min-width: 150px;
      text-align: center; font-family: inherit; color: #fff; letter-spacing: 3px;
      font-size: max(13px, calc(15px + var(--fs-d, 0px))); font-weight: bold;
      background: rgba(10,13,18,.92); border: 1px solid rgba(var(--nc-accent), .75);
      border-radius: 3px; box-shadow: 0 0 18px rgba(var(--nc-accent), .18) inset;
      transition: background .15s, color .15s, border-color .15s; }
    .nc-go:hover { background: rgba(var(--nc-accent), .9); color: #0b0d12; }
    .nc-go i { display: block; font-style: normal; font-weight: normal; letter-spacing: 2px; margin-top: 2px;
      color: rgba(var(--nc-accent), .95); font-size: max(8px, calc(9px + var(--fs-d, 0px))); }
    .nc-go:hover i { color: rgba(11,13,18,.78); }
    body.ui-compact #node-confirm { width: min(320px, 52vw); min-width: 210px; padding: 10px 10px 10px 20px; gap: 7px;
      min-height: 34vh; max-height: calc(66% - var(--bar-h)); }
    body.ui-compact .nc-head { min-height: 40px; }
    body.ui-compact .nc-title { margin-left: clamp(22px, 20%, 76px); }
    body.ui-compact .nc-base { padding: 6px 8px; gap: 8px; }
    body.ui-compact .nc-base-ava { flex: 0 0 32px; width: 32px; height: 32px; }
    body.ui-compact .nc-go { padding: 7px 14px; min-width: 110px; letter-spacing: 2px; }

    /* ===================================================================
       作战节点伪加载页（#node-loading）：全屏、盖住一切（含 gal / 播报卡），
       图1 停 3s → 交叉淡入 图2 停 2s → 淡出后放行节点内的弹窗动画。
       底图用 cover 铺满，文本全用百分比定位 → 换屏幕尺寸/裁切都跟着走。
       =================================================================== */
    #node-loading { position: fixed; inset: 0; z-index: 600; overflow: hidden;
      background: #05070a; animation: nldIn .25s ease-out both; }
    @keyframes nldIn { from { opacity: 0; } to { opacity: 1; } }
    #node-loading.out { animation: nldOut .55s ease-in both; }
    @keyframes nldOut { from { opacity: 1; } to { opacity: 0; } }
    .nld-bg { position: absolute; inset: 0; background-position: center; background-size: cover;
      background-repeat: no-repeat; transition: opacity .6s ease; }
    .nld-bg2 { opacity: 0; }
    .nld-lines { position: absolute; inset: 0; pointer-events: none; }
    /* 字体按参考图调细：大字只到 light(300)、小字 300~400；中文关卡名仍是 bold。
       字体族优先用系统里的窄体无衬线（Helvetica / Noto Sans），别落到默认的粗黑体。 */
    .nld-op, .nld-code, .nld-name, .nld-tip, .nld-load { position: absolute; left: 0; right: 0;
      text-align: center; color: #fff; text-shadow: 0 2px 18px rgba(0,0,0,.8);
      font-family: 'Helvetica Neue', Helvetica, Arial, 'Noto Sans SC', 'Noto Sans', sans-serif; }
    .nld-op { top: 39%; letter-spacing: .46em; text-indent: .46em; font-size: min(2.15vh, 2.9vw);
      opacity: .9; font-weight: 200; }
    /* 字号同时盯视口**高**与**宽**：底图会被裁切、窄屏也常见，只用 vh 会把中文关卡名挤出屏幕 */
    .nld-code { top: 47%; letter-spacing: .10em; text-indent: .10em; font-weight: 300;
      font-size: min(13.2vh, 10.5vw); line-height: 1.06; }
    .nld-name { top: 60%; font-weight: 700; letter-spacing: .08em; text-indent: .08em;
      font-size: min(7.4vh, 8.2vw); }
    .nld-tip { top: 91%; padding: 0 6vw; letter-spacing: .05em; color: rgba(255,255,255,.88);
      font-weight: 300; font-size: min(1.9vh, 3.1vw); line-height: 1.4; }
    .nld-load { top: 91%; left: auto; right: 3.2vw; text-align: right; letter-spacing: .05em;
      font-size: min(2vh, 2.9vw); font-weight: 300; color: rgba(255,255,255,.92); }
    .nld-load b { font-weight: inherit; }
    body.ui-compact .nld-tip { padding: 0 4vw; }
    body.ui-compact .nld-load { right: 2.4vw; }

    /* ===================================================================
       任务完成条（#mission-done）：作战节点「可以离开了」的那一刻播一次。
       半透明黑宽条 + 文字 + 简化罗德岛标记，整体左右平移（元素之间不错位）。
       尺寸口径（作者拍板）：色带厚度 ×1.5、字 ×1.5、三角边长 ×3、logo 边长 ×4，
       中心点与各元素相对位置不变。
       =================================================================== */
    #mission-done { position: fixed; left: 0; right: 0; top: calc(50% - 4.25vh); height: 25.5vh; min-height: 129px;
      z-index: 500; pointer-events: none; display: flex; align-items: center; justify-content: center;
      gap: 3.9vw; transform: translateX(-108%); will-change: transform;
      background: linear-gradient(to right,
        rgba(6,8,11,0) 0%, rgba(6,8,11,.82) 9%, rgba(6,8,11,.86) 50%, rgba(6,8,11,.82) 91%, rgba(6,8,11,0) 100%);
      animation: missionBand 2.2s cubic-bezier(.22,.7,.2,1) forwards; }
    @keyframes missionBand {
      0%   { transform: translateX(-108%); }
      25%  { transform: translateX(0); }
      70%  { transform: translateX(0); }
      100% { transform: translateX(108%); }
    }
    /* 简化罗德岛标记：黑三角（带一层淡淡外发光，否则在黑条上看不见）+ 贴在上面的 logo 图
       （logo 与三角**同心**；三角 45.36×39.48vh = 上一版 ×1.4，盒子上移 3.2vh 让**底边基本不动**、
       只往上长；logo 仍是 60vh 跟着盒子一起抬，保持同心） */
    .md-mark { position: relative; flex: 0 0 auto; width: 45.36vh; height: 39.48vh;
      min-width: 210px; min-height: 188px; transform: translateY(-3.2vh); }
    .md-tri { position: absolute; left: 50%; bottom: 0; transform: translateX(-50%);
      width: 100%; height: 100%; background: #0a0c11;
      clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
      filter: drop-shadow(0 0 10px rgba(200,220,255,.22)); }
    .md-logo { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: 60vh; height: 60vh; object-fit: contain; }
    .md-txt { display: flex; flex-direction: column; align-items: center; line-height: 1.05; color: #fff; }
    .md-cn { font-weight: bold; letter-spacing: .3em; text-indent: .3em; text-shadow: 0 3px 16px rgba(0,0,0,.9);
      font-size: clamp(33px, 8.4vh, 117px); }
    .md-en { margin-top: .35vh; letter-spacing: .26em; text-indent: .26em; color: rgba(255,255,255,.9);
      font-weight: 300; font-size: clamp(13px, 2.85vh, 39px); }
    .md-sub { margin-top: .6vh; letter-spacing: .34em; text-indent: .34em; color: rgba(255,255,255,.5);
      font-size: clamp(10px, 1.65vh, 23px); }
    /* 紧凑档同样按 1.5 倍口径（原 14vh / 68px → 21vh / 102px） */
    body.ui-compact #mission-done { height: 21vh; min-height: 102px; gap: 21px; top: calc(50% - 3.5vh); }

    /* ===================================================================
       地图专用布局（body.in-map）
       - 问题1：地图整体上移（顶部留白对齐内容），把底部聊天记录让出来；
       - 问题3：小屏时挤压缩放 + 支持鼠标/触摸拖拽平移（左右 + 小幅上下），
                四周留出保险留白，保证每个节点都能被拖到并看清。
       =================================================================== */
    body.in-map #main-content { display: block; }               /* 地图让内容区不再居中，改为块级滚动容器 */
    body.in-map .map-scroll { height: calc(100% - 34px);        /* 占满舞台残留高度（留底部一行给提示），上下可滚动 */
      overflow-x: auto; overflow-y: auto;
      touch-action: none;                                       /* 由 JS 接管触控拖拽 */
      scrollbar-width: none; -ms-overflow-style: none; }
    body.in-map .map-scroll::-webkit-scrollbar { width: 0; height: 0; background: transparent; }
    body.in-map .map-scroll.panning { cursor: grabbing; }
    body.in-map .map-scroll { cursor: grab; }
    body.in-map .map-inner { align-items: center;               /* 节点高度<居中对齐>：各列按垂直中线排布 */
      min-height: 100%;                                          /* 撑满滚动区高度，让 align-items:center 真正居中 */
      justify-content: flex-start;                              /* 横向从左排，配合横滚/拖拽 */
      padding-top: 30px;                                        /* 顶部留白（轻微让出顶栏视野） */
      padding-bottom: 104px;                                    /* 底部留白更大 → 节点视觉中线稍偏上移，避开聊天 */
      padding-left: 72px; padding-right: 72px; }                /* 左右保险留白（拖到都能露出） */
    /* 挤压缩放：随屏宽缩小节点与间距，适配小屏 */
    @media (max-width: 900px) {
      body.in-map .map-node { width: 152px; height: 152px; }
      body.in-map .map-inner { gap: 116px; padding-top: 24px; padding-bottom: 84px;
        padding-left: 56px; padding-right: 56px; }
    }
    @media (max-width: 640px) {
      body.in-map .map-node { width: 128px; height: 128px; }
      body.in-map .map-col { gap: 16px; }
      body.in-map .map-inner { gap: 78px; padding-top: 20px; padding-bottom: 68px;
        padding-left: 44px; padding-right: 44px; }
    }
    @media (max-width: 400px) {
      body.in-map .map-node { width: 108px; height: 108px; }
      body.in-map .map-col { gap: 16px; }
      body.in-map .map-inner { gap: 60px; padding-top: 16px; padding-bottom: 56px;
        padding-left: 36px; padding-right: 36px; }
    }
    #chat-container.expanded { height: 88%; }
    /* 展开态：内容更多 → 渐变更重一档（底部仍最实，顶部仍渐隐） */
    #chat-container.expanded { background: linear-gradient(to top,
      rgba(4,6,10,.95) 0%, rgba(4,6,10,.88) 34%, rgba(5,7,12,.68) 66%, rgba(5,7,12,.24) 88%, rgba(5,7,12,.02) 100%); }
    /* ---- 棋盘/地图类界面：聊天面板置左侧约 1/4、向右展开；内容区偏置于右侧 ---- */
    body.in-chat-left #chat-container { left: 0; right: auto; top: var(--bar-h); bottom: 0; height: auto;
      width: 25%;
      background: linear-gradient(to top,
        rgba(4,6,10,.88) 0%, rgba(4,6,10,.74) 34%, rgba(5,7,12,.46) 66%, rgba(5,7,12,.10) 88%, rgba(5,7,12,0) 100%);
      border-top: none; border-right: 1px solid rgba(150,170,210,0.18); }
    body.in-chat-left #chat-container.expanded { width: 70%; }
    /* #chat-expand 已改为全局 fixed（见上），in-chat-left 布局不再需要独立的按钮定位 */
    body.in-chat-left #chat-input-area { flex-direction: column; align-items: stretch; gap: 6px; }
    body.in-chat-left #chat-input-area select, body.in-chat-left #chat-input-area button { width: 100%; }
    body.in-chat-left #stage, body.in-chat-left #chat-container { transition: width 0.2s ease; }
    /* 棋盘类界面聊天在左，游戏区不再给底部聊天留白，占满剩余高度 */
    body.in-chat-left #stage { bottom: 0; }
    /* 内容区（棋盘等）向右偏置，避免被左侧聊天盖住；小屏时聊天更窄、棋盘可滑动 */
    body.in-chat-left #main-content { padding-left: 25%; }
    @media (max-width: 900px) {
      body.in-chat-left #chat-container { width: 34%; }
      body.in-chat-left #chat-container.expanded { width: 78%; }
      body.in-chat-left #main-content { padding-left: 34%; }
    }
    @media (max-width: 560px) {
      /* 窄屏：聊天收窄成细栏，主内容占满剩余区域；棋盘/地图容器可横向滑动翻页（滚动条已隐藏） */
      body.in-chat-left #chat-container { width: 40%; }
      body.in-chat-left #chat-container.expanded { width: 84%; }
      body.in-chat-left #main-content { padding-left: 40%; }
      body.in-chat-left #chat-history { padding: 8px 6px; }
      body.in-chat-left .board { transform: rotateX(10deg) scale(0.8); }
      body.in-chat-left #main-content { align-items: flex-start; }
      .board-wrap { max-width: 100%; }
    }
    /* ---- 主城家园 ---- */
    .home-view { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    .home-deco { text-align: center; max-width: 540px; }
    /* 〘游戏外·右下角操作列〙
       ⚠ 与 .radar-panel **同一口径**：右缘 8px、宽 = --right-col - 16（桌面 244 / 紧凑档 160）。
       ⚠ 必须 position: fixed —— 这一列要和雷达一样"贴屏幕底、嵌进聊天面板让出来的那条竖列"；
        用 absolute 会锚在 .home-view 上，父级实际高度一旦不是满屏，bottom 就落到半屏幕处（实测踩过）。
        fixed 与 #gal-layer / .radar-panel / #chat-expand 同一套写法，不受祖先链影响。 */
    .home-side { position: fixed; right: 8px; bottom: 8px;
      width: calc(var(--right-col) - 16px); display: flex; flex-direction: column;
      gap: 10px; align-items: stretch; z-index: 60; }
    .home-side > .big-btn { width: 100%; }
    /* 主界面加载标题：居中短暂浮现（纯装饰，几秒后自动淡出，不留文案） */
    .title-splash { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      z-index: 500; font-size: calc(34px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; letter-spacing: 12px;
      color: #ffd98c; text-shadow: 0 4px 24px rgba(0,0,0,.85);
      pointer-events: none; user-select: none; white-space: nowrap;
      animation: titleSplash 1.9s ease forwards; }
    @keyframes titleSplash {
      0% { opacity: 0; transform: translate(-50%, -50%) scale(.96); }
      12% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      78% { opacity: 1; }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(1.02); }
    }
    /* 主城「打开过场」铺底：旧主城背景图整屏铺开，与标题文字同起同落（3.2s 一起淡出）。
       · z-index 490 = 盖住主城 UI（home-side 60 / #game-page 460 / 470），但压不住标题(500)与弹窗(99999)。
       · 铺满最上层但 pointer-events:none → 过场期间点击直接穿透，不挡「出门探索」等按钮。
       · 动画曲线与 .title-splash 完全一致（12% 淡入完、78% 起淡出），两者才像"一起打个照面"。 */
    .home-splash { position: fixed; inset: 0; z-index: 490;
      background-repeat: no-repeat; background-size: cover; background-position: center;
      pointer-events: none; user-select: none;
      animation: homeSplashFade 1.9s ease forwards; }
    @keyframes homeSplashFade {
      0% { opacity: 0; }
      12% { opacity: 1; }
      78% { opacity: 1; }
      100% { opacity: 0; }
    }
    /* 「出门探索」+ 难度数字按钮 并排（在右下角操作列里：探索键占满剩余宽，难度键固定方块） */
    .home-go-row { position: relative; display: flex; align-items: center; gap: 8px; }
    /* 标本室按钮行（原「标本室 / 存档」并排已合并：现在只有「🫙 标本室」一个整宽按钮，
       存档页已并入标本室的时间线折叠树；保留这层包裹是为了不影响其它 home-side 布局口径） */
    .home-archive-row { display: flex; align-items: stretch; gap: 10px; }
    .home-archive-row .big-btn { flex: 1 1 0; min-width: 0; }
    .btn-replay-on { border-color: rgba(255,217,140,.72) !important; color: #ffe6b0 !important; }
    .home-side .big-btn.gate-locked, .home-side .diff-num-btn.gate-locked { opacity: .42; cursor: not-allowed; }
    /* 〘短对局开关〙「短对局」文本 + 滑块，排在「干员开关」上面一格。
       与 .diff-num-btn 同一套语汇（深底 / 细边 / 亮字），开态用金色滑块 + 光晕表示。 */
    .home-short-row { display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 8px 12px; border-radius: 10px; cursor: pointer;
      background: rgba(16,20,28,0.92); border: 2px solid #6f7f9c;
      transition: border-color .15s, background .15s; }
    .home-short-row:hover { border-color: #ffd25c; background: rgba(30,36,48,0.96); }
    .home-short-row .hs-label { font-size: max(12px, calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)));
      color: #cfd8e3; letter-spacing: 1px; line-height: 1.2; }
    .home-short-row.on .hs-label { color: #ffe6b0; }
    .home-short-row .hs-switch { position: relative; flex: 0 0 auto; width: 46px; height: 22px; padding: 0;
      border-radius: 999px; border: 1px solid #4a5060; background: #23262f;
      cursor: pointer; font-family: inherit; transition: background .18s, border-color .18s; }
    .home-short-row .hs-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
      border-radius: 50%; background: #9aa3b0; transition: left .18s, background .18s; }
    .home-short-row.on .hs-switch { background: rgba(255,210,92,.20); border-color: #ffd25c; }
    .home-short-row.on .hs-knob { left: 26px; background: #ffd98c; box-shadow: 0 0 10px rgba(255,210,92,.6); }
    .home-short-row.gate-locked { opacity: .42; cursor: not-allowed; }
    .home-short-row.gate-locked .hs-switch { pointer-events: none; }
    body.ui-compact .home-short-row { padding: 5px 9px; }
    body.ui-compact .home-short-row .hs-label { font-size: max(11px, calc(12px + var(--fs-d, 0px))); }
    /* ===== 失败锁定态（body.run-failed）=====
       核心生命归零时不立刻退首页：冻结**一切会改变对局的操作**（发消息 / 选项 / 重roll / 熔断 /
       设基底 / 晋升 / 离开节点 / 商店购买 / 地图点节点），但**保留纯浏览**（聊天记录滚动、gal 翻页、
       顶栏的编队・标本室・收藏品库、全屏、关闭）—— 给玩家缓冲时间看结局。
       唯一的出口是 #fail-banner 里那一个「返回罗德岛」按钮（z 455：压住 HUD/gal，但不挡整页浏览器 460）。 */
    body.run-failed #chat-send,
    body.run-failed #chat-reroll,
    body.run-failed #chat-input,
    body.run-failed #drop-base,
    body.run-failed #emergency-btn,
    body.run-failed .opt-card,
    body.run-failed #shop-buy-btn,
    body.run-failed #node-leave-btn,
    body.run-failed #prep-start,
    body.run-failed .promote-btn,
    body.run-failed #pg-promote,
    body.run-failed .map-node { pointer-events: none !important; opacity: .45; filter: saturate(.6); }
    #fail-banner { position: fixed; top: calc(var(--bar-h, 48px) + 10px); left: 50%; transform: translateX(-50%);
      z-index: 455; width: min(680px, 92vw); text-align: center; box-sizing: border-box;
      background: rgba(28,10,12,.95); border: 1px solid rgba(255,90,90,.62); border-radius: 12px;
      padding: 12px 18px 14px; box-shadow: 0 10px 30px rgba(0,0,0,.62); color: #ffe3e3; }
    #fail-banner .fb-title { font-size: calc(17px + var(--fs-d, 0px) + var(--fs-dl, 0px));
      font-weight: bold; letter-spacing: 3px; color: #ff8f8f; }
    #fail-banner .fb-sub { margin: 6px 0 10px; font-size: max(11px, calc(12px + var(--fs-d, 0px)));
      line-height: 1.65; color: #e6c8c8; }
    #fail-banner #fail-return { pointer-events: auto; }
    /* ===== 自定义滚动条（全站统一：不再出现浏览器默认的灰白条） =====
       用法：给任何 overflow:auto/scroll 的容器加 class="ds-scroll"。
       · WebKit（Chrome/Edge/Safari/安卓与 iOS 的 WebView）：8px、轨道透明、滑块半透明蓝灰 + 圆角，
         hover 提亮一档；border 2px 透明 + background-clip:padding-box 做出"滑块比轨道窄"的留白效果。
       · Firefox：scrollbar-width: thin + scrollbar-color（两值写法，轨道透明）。
       · 触屏紧凑档再收窄到 5px：手指滚动时几乎看不见，但不至于完全消失（桌面仍能拖）。
       ⚠ 不要用 scrollbar-width: none —— 那样连桌面拖拽都没了，长列表会很难翻。 */
    .ds-scroll { scrollbar-width: thin; scrollbar-color: rgba(150,170,210,.34) transparent; }
    .ds-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
    .ds-scroll::-webkit-scrollbar-track { background: transparent; }
    .ds-scroll::-webkit-scrollbar-thumb {
      background-color: rgba(150,170,210,.30); border: 2px solid transparent;
      background-clip: padding-box; border-radius: 999px; }
    .ds-scroll::-webkit-scrollbar-thumb:hover { background-color: rgba(190,210,240,.55); }
    .ds-scroll::-webkit-scrollbar-thumb:active { background-color: rgba(255,217,140,.62); }
    .ds-scroll::-webkit-scrollbar-corner { background: transparent; }
    body.ui-compact .ds-scroll { scrollbar-width: thin; }
    body.ui-compact .ds-scroll::-webkit-scrollbar { width: 5px; height: 5px; }
    body.ui-compact .ds-scroll::-webkit-scrollbar-thumb { border-width: 1px; }

    /* ===== 标本室 · 时间线折叠树（原「存档页」与「标本库平铺页」合并后唯一的一套样式）=====
       层级：.sp-row（一级行：一条时间线）> .sp-body > .sp-sub（二级栏：时间线 / 标本库）> 内容。
       收起态一律 display:none —— 不靠 max-height 动画，避免"展开后高度算错"的老坑。 */
    .sp-tree { display: flex; flex-direction: column; gap: 8px; }
    .sp-row { border: 1px solid rgba(150,170,210,.22); border-radius: 10px;
      background: rgba(255,255,255,.028); overflow: hidden; }
    .sp-row.on { border-color: rgba(255,217,140,.45); background: rgba(255,217,140,.05); }
    .sp-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
      cursor: pointer; user-select: none; -webkit-user-select: none; }
    .sp-row.open > .sp-head { border-bottom: 1px solid rgba(150,170,210,.16); }
    .sp-arrow { flex: 0 0 auto; display: inline-block; color: #7f8a99; line-height: 1;
      font-size: max(10px, calc(11px + var(--fs-d, 0px)));
      transition: transform .16s ease, color .16s; }
    .sp-row.open > .sp-head .sp-arrow,
    .sp-sub.open > .sp-subhead .sp-arrow { transform: rotate(90deg); color: #ffd98c; }
    .sp-title { flex: 0 1 auto; min-width: 0; font-weight: bold; letter-spacing: .5px; color: #ffd98c;
      font-size: max(12px, calc(14px + var(--fs-d, 0px))); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; cursor: text; }
    .sp-title:hover { color: #ffe9b8; text-shadow: 0 0 10px rgba(255,210,92,.28); }
    .sp-title-dim { color: #8f99a8; font-weight: normal; cursor: default; white-space: normal; }
    .sp-title-dim:hover { color: #8f99a8; text-shadow: none; }
    .sp-hash { color: #7f8a99; font-weight: normal; }
    /* 行标题的原地改名输入框 */
    .sp-rename { width: min(240px, 46vw); font-family: inherit; color: #ffe9b8;
      background: rgba(9,11,16,.9); border: 1px solid rgba(255,210,92,.62); border-radius: 5px;
      padding: 1px 6px; font-size: max(12px, calc(14px + var(--fs-d, 0px))); outline: none; }
    .sp-rename::placeholder { color: #6f7887; }
    .sp-meta { flex: 0 1 auto; min-width: 0; color: #8f99a8; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; font-size: max(11px, calc(12px + var(--fs-d, 0px))); }
    .sp-live { flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; letter-spacing: 0;
      font-size: max(10px, calc(11px + var(--fs-d, 0px))); color: #1a1206;
      background: linear-gradient(180deg, #ffe6b0, #f0c268); }
    .sp-spacer { flex: 1 1 auto; min-width: 6px; }
    /* 启用开关（互斥）：与主城「短对局」滑块同一套外观语汇（深底细边 + 金色滑块 + 光晕） */
    .sp-tgl { position: relative; flex: 0 0 auto; width: 44px; height: 22px; padding: 0; cursor: pointer;
      border-radius: 999px; border: 1px solid #4a5060; background: #23262f; font-family: inherit;
      transition: background .18s, border-color .18s; }
    .sp-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
      background: #9aa3b0; transition: left .18s, background .18s; }
    .sp-tgl:hover { border-color: #ffd25c; }
    .sp-tgl.on { background: rgba(255,210,92,.20); border-color: #ffd25c; }
    .sp-tgl.on .sp-knob { left: 24px; background: #ffd98c; box-shadow: 0 0 10px rgba(255,210,92,.6); }
    .sp-tgl.lock { opacity: .38; cursor: not-allowed; }
    .sp-tgl.lock:hover { border-color: #4a5060; }
    /* 一级行的内容区（展开才显示） */
    .sp-body { display: none; padding: 2px 12px 10px; }
    .sp-row.open > .sp-body { display: block; }
    /* 二级栏（时间线 / 标本库 / 异常组） */
    .sp-sub { border-top: 1px dashed rgba(150,170,210,.18); }
    .sp-sub:first-child { border-top: none; }
    .sp-subhead { display: flex; align-items: center; gap: 8px; padding: 8px 2px;
      cursor: pointer; user-select: none; -webkit-user-select: none; color: #b9c2d0;
      font-size: max(11px, calc(13px + var(--fs-d, 0px))); }
    .sp-subhead:hover { color: #e8eef8; }
    .sp-subname { font-weight: bold; letter-spacing: 1px; }
    .sp-count { color: #8f99a8; font-size: max(10px, calc(11px + var(--fs-d, 0px))); }
    .sp-subbody { display: none; padding: 2px 0 10px; }
    .sp-sub.open > .sp-subbody { display: block; }
    /* 二级栏内容内缩一档：让"谁属于谁"一眼看得出来 */
    .sp-sub.open > .sp-subbody > .tl,
    .sp-sub.open > .sp-subbody > .du-grid { margin-left: 14px; }
    .sp-note { color: #7b8595; line-height: 1.8; padding: 4px 0 6px;
      font-size: max(11px, calc(12px + var(--fs-d, 0px))); }
    .sp-note + .sp-note { border-top: 1px dashed rgba(150,170,210,.14); }
    .sp-anomaly { border-color: rgba(255,140,120,.28); background: rgba(255,120,100,.045); }
    .sp-anomaly .sp-arrow { color: #b0705f; }
    /* 行标题旁的 ✎ 改名键：平时低亮度，hover/触屏常态也能按到（别做成只在 hover 才出现的隐形按钮） */
    .sp-edit { flex: 0 0 auto; padding: 1px 5px; cursor: pointer; font-family: inherit; line-height: 1.2;
      color: #8f99a8; background: transparent; border: 1px solid transparent; border-radius: 4px;
      font-size: max(11px, calc(12px + var(--fs-d, 0px))); opacity: .55; transition: opacity .15s, color .15s, border-color .15s; }
    .sp-edit:hover, .sp-edit:active { opacity: 1; color: #ffd98c; border-color: rgba(255,210,92,.5); background: rgba(255,217,140,.08); }
    /* 改名输入框在 .sp-title 里：它默认 nowrap+ellipsis，编辑时必须放开裁切，否则输入框被切成半截 */
    .sp-title.editing { overflow: visible; white-space: normal; cursor: auto; }
    .home-go-row .big-btn { flex: 1 1 auto; min-width: 0; }
    .home-go-row .diff-num-btn { flex: 0 0 auto; margin-left: 0; }
    .diff-num-btn { display: flex; flex-direction: column; align-items: center; justify-content: center;
      width: 62px; height: 62px; margin-left: -14px; padding: 0; cursor: pointer;
      background: rgba(16,20,28,0.92); border: 2px solid #6f7f9c; border-radius: 10px;
      color: #e8eef8; font-family: inherit; transition: 0.15s; box-shadow: 0 4px 12px rgba(0,0,0,0.45); }
    .diff-num-btn:hover { border-color: #ffd25c; background: rgba(30,36,48,0.96); }
    .diff-num-btn .dnb-cap { font-size: max(9px, calc(9px + var(--fs-d, 0px))); color: #9aa3b0; letter-spacing: 1px; }
    .diff-num-btn .dnb-num { font-size: calc(20px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; color: #ffd98c; line-height: 1.05; }
    .diff-num-btn.inert { border-color: #4a5060; }
    .diff-num-btn.inert .dnb-num { color: #cfd8e3; }
    /* ================= 难度全屏轮盘（上下滑动） ================= */
    .diff-wheel-overlay { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column;
      background: linear-gradient(180deg, rgba(9,11,16,0.97), rgba(13,17,24,0.99)); backdrop-filter: blur(3px); }
    .diff-wheel-head { flex: 0 0 auto; padding: 22px 24px 10px; text-align: center; font-size: calc(20px + var(--fs-d, 0px) + var(--fs-dl, 0px));
      font-weight: bold; color: #ffd98c; letter-spacing: 4px; }
    .diff-wheel-head .dif-hint { display: block; margin-top: 6px; font-size: max(11px, calc(11px + var(--fs-d, 0px))); font-weight: normal;
      color: #8b95a6; letter-spacing: 0; }
    .diff-wheel-list { flex: 1 1 auto; overflow: hidden; padding: 0 24px; position: relative;
      pointer-events: none; }   /* 禁止手动滚动/点击：唯一换档入口 = ▲/▼ 箭头按钮（scrollTo 程序化滚动仍生效） */
    .diff-wheel-list::-webkit-scrollbar { width: 0; height: 0; background: transparent; }
    /* 上下切换箭头（纯按钮驱动，不依赖触摸/滚轮） */
    .dw-arrow { flex: 0 0 auto; width: 100%; height: 42px; border: none; cursor: pointer;
      background: rgba(18,22,30,0.9); color: #ffd98c; font-size: calc(18px + var(--fs-d, 0px) + var(--fs-dl, 0px)); line-height: 1;
      border-top: 1px solid rgba(140,160,200,0.16); border-bottom: 1px solid rgba(140,160,200,0.16);
      transition: 0.15s; }
    .dw-arrow:hover:not(:disabled) { background: rgba(40,44,32,0.95); color: #ffe3a0; }
    .dw-arrow:disabled { color: #4a5060; cursor: default; }
    .dw-item { min-height: 96px; height: 96px;   /* 实际行高由 _openDifficultyWheel 按像素写入（箭头驱动） */
      display: flex; flex-direction: column; justify-content: center; gap: 6px;
      padding: 12px 20px; margin: 0; border: 1px solid rgba(140,160,200,0.14); border-radius: 10px;
      background: rgba(18,22,30,0.55); opacity: 0.5; transform: scale(0.94);
      transition: opacity 0.18s, transform 0.18s, border-color 0.18s, background 0.18s; cursor: default; }
    .dw-item.selected { opacity: 1; transform: scale(1); border-color: #ffd25c;
      background: rgba(40,44,32,0.55); box-shadow: 0 0 22px rgba(255,210,92,0.18) inset; }
    .dw-item-top { display: flex; align-items: center; gap: 18px; }
    .dw-num { min-width: 62px; text-align: center; font-size: calc(38px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; color: #e8eef8;
      line-height: 1.1; text-shadow: 0 2px 10px rgba(0,0,0,0.7); }
    .dw-item.selected .dw-num { color: #ffd98c; }
    .dw-name { font-size: calc(18px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; color: #dfe8f5; }
    .dw-sub { font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #9aa3b0; margin-top: 2px; }
    .dw-effs { padding-left: 80px; }
    .dw-eff { font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #b9c2d0; line-height: 1.65; }
    .diff-wheel-foot { flex: 0 0 auto; display: flex; justify-content: center; align-items: center;
      gap: 14px; padding: 14px 24px 24px; }
    /* ================= 分队 · 横向大字选牌 ================= */
    .sq-view { width: 100%; height: 100%; display: flex; flex-direction: column; padding-top: var(--bar-h); }
    .sq-title { flex: 0 0 auto; text-align: center; padding: 16px 0 10px; font-size: calc(22px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold;
      color: #ffd98c; letter-spacing: 6px; text-shadow: 0 2px 12px rgba(0,0,0,0.8); }
    /* 选牌行：按钮搬走后这一行会吃到整屏高度 —— 卡片**不再拉满**，改为居中 + 限高，
       否则 178px 宽的牌子会被拉成一根细长条（内容只占其中一小段）。 */
    .sq-scroll { flex: 1 1 auto; min-height: 0; display: flex; gap: 14px; align-items: center;
      overflow-x: auto; overflow-y: hidden; padding: 6px 26px 10px; scrollbar-width: none; -ms-overflow-style: none; }
    .sq-scroll::-webkit-scrollbar { width: 0; height: 0; background: transparent; }
    .sq-card { flex: 0 0 178px; height: min(100%, 380px); display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 8px;
      padding: 16px 12px; border: 1px solid rgba(140,160,200,0.22); border-radius: 10px; position: relative;
      background: rgba(14,17,23,0.62); cursor: pointer; transition: 0.15s; }
    .sq-card:hover { border-color: #ffd25c; background: rgba(24,29,38,0.8); }
    .sq-card.selected { border-color: #ffd25c; background: rgba(35,32,20,0.66);
      box-shadow: 0 0 0 2px rgba(255,210,92,0.28) inset; }
    .sq-card .sq-icon { height: 88px; display: flex; align-items: center; justify-content: center; }
    .sq-card .sq-name { font-size: calc(16px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; color: #e8eef8; letter-spacing: 2px;
      text-align: center; text-shadow: 0 2px 8px rgba(0,0,0,0.8); }
    .sq-card .sq-tag { font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #ffd98c; text-align: center; }
    .sq-card .sq-desc { font-size: max(11px, calc(11px + var(--fs-d, 0px))); color: #b9c2d0; text-align: center; line-height: 1.6; }
    .sq-card.locked { cursor: not-allowed; opacity: 0.42; filter: grayscale(0.6); }
    .sq-card.locked:hover { border-color: rgba(140,160,200,0.22); background: rgba(14,17,23,0.62); }
    .sq-card .sq-lock { position: absolute; right: 8px; bottom: 8px; font-size: max(10px, calc(10px + var(--fs-d, 0px))); color: #cfd8e3;
      background: rgba(0,0,0,0.55); border: 1px solid rgba(140,160,200,0.3); border-radius: 4px; padding: 2px 6px; }
    /* 说明文字：已并进右下角操作列（.sq-btns 的第一个子级，见 renderSquadSelect）——
       它说的就是"当前选中的分队"，理应贴在「确认编队」上方；留在页面底部会被输入行盖住。 */
    .sq-tip { flex: 0 0 auto; text-align: center; font-size: max(11px, calc(12px + var(--fs-d, 0px)));
      color: #cfd8e3; line-height: 1.5; padding: 0 2px; }
    .sq-tip b { color: #ffd98c; }
    .sq-tip .sq-note { color: #8b95a6; }
    /* 〘游戏外·右下角操作列〙同 .home-side：fixed 贴屏幕底，嵌进聊天面板让出的那条竖列
       （absolute 会锚在 #main-content / .sq-view 上，父级高度不可靠 → 按钮会飘到半屏）。
       跳出 .sq-view 的纵向流后，上方的选牌行就能吃满剩余高度。 */
    .sq-btns { position: fixed; right: 8px; bottom: 8px;
      width: calc(var(--right-col) - 16px); display: flex; flex-direction: column;
      gap: 10px; padding: 0; z-index: 60; }
    .sq-btns .big-btn { width: 100%; }
    /* ---- 通用节点/结算界面：聊天占满 + 右侧悬浮选项条（不遮挡聊天） ---- */
    .top-drop-panel { position: fixed; top: var(--bar-h); left: 50%; transform: translateX(-50%);
      width: min(640px, 92vw); max-height: 66vh; overflow-y: auto; z-index: 95;
      background: rgba(13,16,23,0.96); border: 1px solid rgba(150,170,210,0.3); border-radius: 10px;
      padding: 14px; box-shadow: 0 12px 30px rgba(0,0,0,0.5); display: flex; flex-direction: column; gap: 8px; }
    .top-drop-panel .dp-title { font-size: max(11px, calc(13px + var(--fs-d, 0px))); font-weight: bold; color: #ffd98c; margin-bottom: 2px; }
    .collect-item { font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #ddd; padding: 6px 8px; border-bottom: 1px solid #2a2e38; }
    .collect-item b { color: #ffd98c; }
    .collect-item .d { color: #9aa3b0; font-size: max(11px, calc(11px + var(--fs-d, 0px))); }
    /* 干员卡 */
    .dp-grid { display: flex; flex-wrap: wrap; gap: 10px; }
    .op-cqcard { width: 200px; background: #1c1e24; border: 1px solid #4a5060; border-radius: 10px;
      padding: 10px; display: flex; flex-direction: column; gap: 6px; }
    .op-cqcard .cq-head { display: flex; align-items: center; gap: 8px; }
    .op-cqcard .cq-head img { width: 46px; height: 46px; object-fit: contain; border-radius: 6px;
      background: #111; }
    .op-cqcard .cq-head .cq-name { font-size: max(11px, calc(13px + var(--fs-d, 0px))); font-weight: bold; color: #ffd98c; }
    .op-cqcard .cq-row { font-size: max(11px, calc(11px + var(--fs-d, 0px))); color: #ccc; display: flex; justify-content: space-between; }
    .op-cqcard .cq-row b { color: #eee; }
    .op-cqcard .cq-push { font-size: max(11px, calc(11px + var(--fs-d, 0px))); color: #9fe3ff; }
    .op-cqcard .cq-tag { font-size: max(10px, calc(10px + var(--fs-d, 0px))); color: #b9c2d0; background: #23262f; border-radius: 4px;
      padding: 2px 5px; }
    .op-cqcard .cq-schema { font-size: max(10px, calc(10px + var(--fs-d, 0px))); color: #8a93a2; border-top: 1px dashed #3a3f4a; padding-top: 5px;
      line-height: 1.5; overflow: hidden; max-height: 74px; }
    .op-cqcard .promote-btn { font-size: max(11px, calc(11px + var(--fs-d, 0px))); background: #2b5a8f; color: #fff; border: none; border-radius: 5px;
      padding: 5px; cursor: pointer; }
    .op-cqcard .promote-btn.done { background: #3a3f4a; color: #888; cursor: default; }
    .op-cqcard .promote-btn:disabled { cursor: default; }
    /* 右侧悬浮检视面板（棋盘内单击干员/备战区） */

    /* ===== 补充 UI ===== */
    .op-grid { display: flex; flex-wrap: wrap; gap: 10px; padding: 6px; justify-content: center; }
    .op-card { position: relative; width: 88px; background: #1c1e24; border: 2px solid #555; border-radius: 8px;
      display: flex; flex-direction: column; align-items: center; padding: 6px; cursor: pointer; }
    .op-card img { width: 54px; height: 54px; object-fit: contain; }
    .op-card .nm { font-size: max(10px, calc(10px + var(--fs-d, 0px))); color: #ddd; margin-top: 3px; text-align: center; word-break: break-all; }
    .op-card .tag { font-size: max(9px, calc(9px + var(--fs-d, 0px))); color: #9aa3b0; }
    .op-card.promote-pick { border-color: #2bb86e; background: rgba(43,184,110,.18); }
    .op-card.disabled { opacity: .4; pointer-events: none; }
    .sec-title { font-size: max(11px, calc(13px + var(--fs-d, 0px))); color: #faad14; margin: 10px 2px 6px; font-weight: bold; }
    .panel-box { background: rgba(13,16,23,.97); border: 1px solid rgba(150,170,210,.35); border-radius: 10px;
      padding: 14px 16px; max-width: min(720px, 92vw); max-height: 82%; overflow-y: auto; }
    .panel-box h3 { margin: 0 0 10px; color: #ffd98c; text-align: center; }
    .panel-row { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
    .mini-btn { background: #2b5a8f; color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: max(11px, calc(12px + var(--fs-d, 0px))); }
    .mini-btn.gray { background: #444; }
    .mini-btn.gold { background: #b8860b; }
    .mini-btn:disabled { opacity: .45; cursor: not-allowed; }
    .col-item { font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #ddd; padding: 6px 10px; border-bottom: 1px solid #2a2e38; }
    .col-item b { color: #ffd98c; }
    .col-item .d { color: #9aa3b0; font-size: max(11px, calc(11px + var(--fs-d, 0px))); }
    .kv { display: inline-block; font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #cfd8e3; background: #23262f; border: 1px solid #3a3f4a;
      border-radius: 6px; padding: 4px 8px; margin: 3px; }
    .kv b { color: #7ec8ff; }
    .ins-sec { font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #d5dae3; line-height: 1.8; padding: 6px 10px; background: #191c22;
      border-radius: 6px; margin: 6px 0; }
    .ins-sec b { color: #ffd98c; }

    /* ===== 整页浏览器：干员编队 / 标本库 / 收藏品库 =====
       铺满顶栏以下的整页（不是随条数挤压的悬浮窗）；左详情栏 + 右列表各自独立滚动。 */
    #game-page { position: fixed; top: var(--bar-h); left: 0; right: 0; bottom: 0; z-index: 460;
      display: flex; flex-direction: column;
      background: linear-gradient(165deg, rgba(9,11,16,.99), rgba(15,19,27,.99)); }
    .pg-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
      padding: 10px 16px; background: rgba(20,25,34,.92);
      border-bottom: 1px solid rgba(150,170,210,.22); }
    .pg-title { font-size: calc(16px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; color: #ffd98c; letter-spacing: 1px; }
    .pg-sub { font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #8f99a8; }
    .pg-spacer { flex: 1 1 auto; }
    .pg-body { flex: 1 1 auto; min-height: 0; display: flex; }
    .pg-side { flex: 0 0 300px; min-height: 0; overflow-y: auto; padding: 12px 12px 20px;
      background: rgba(13,16,22,.78); border-right: 1px solid rgba(150,170,210,.18); }
    .pg-main { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; padding: 12px 16px 26px; }
    .pg-sec { font-size: max(11px, calc(13px + var(--fs-d, 0px))); font-weight: bold; color: #ffd98c; margin: 14px 2px 8px; }
    .pg-sec:first-child { margin-top: 2px; }
    .pg-empty { color: #7b8595; font-size: max(11px, calc(13px + var(--fs-d, 0px))); line-height: 1.9; text-align: center; padding: 36px 10px; }

    /* ---- 干员宽卡（左胸像 / 右名称 + 三轴雷达 + 数值）----
       高度 100→202（约翻倍）：原来的 100px 会把 180×360 的胸像裁得只剩小半张脸，
       现在 art 区按 object-fit:contain 完整显示胸像主体，右侧空间同步放大字体与雷达。 */
    .du-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 10px; }
    .du-card { position: relative; display: flex; height: 202px; overflow: hidden; cursor: pointer;
      background: linear-gradient(100deg, #1b2130 0%, #141821 62%, #12161d 100%);
      border: 1px solid #39414f; border-radius: 8px; transition: border-color .12s, box-shadow .12s; }
    .du-card:hover { border-color: #6d7b92; }
    .du-card.sel { border-color: #ffd98c;
      box-shadow: 0 0 0 1px rgba(255,217,140,.45), 0 0 14px rgba(255,217,140,.18); }
    .du-art { flex: 0 0 140px; overflow: hidden;
      background: radial-gradient(circle at 50% 82%, rgba(120,160,215,.20), rgba(60,80,120,.05) 62%, transparent 76%); }
    /* contain：完整显示胸像，不裁头不裁身（原来 cover + 6% 会把上身切掉） */
    .du-art img { width: 100%; height: 100%; object-fit: contain; object-position: 50% 50%; }
    .du-meta { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; justify-content: center;
      gap: 9px; padding: 12px 14px 12px 10px; }
    .du-nm { font-size: calc(19px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; color: #eef3fa;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .du-idx { font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #8f99a8; margin-left: 6px; font-weight: normal; }
    .du-row { display: flex; align-items: center; gap: 12px; }
    .du-radar { flex: 0 0 auto; line-height: 0; }
    .du-nums { display: flex; flex-direction: column; gap: 6px; font-size: max(11px, calc(13px + var(--fs-d, 0px))); color: #9aa3b0; min-width: 0; }
    .du-nums i { font-style: normal; white-space: nowrap; }
    .du-nums b { color: #7ec8ff; }
    .du-ribbon { position: absolute; left: 0; top: 0; z-index: 2; font-size: max(11px, calc(12px + var(--fs-d, 0px))); line-height: 1;
      padding: 4px 11px 4px 9px; color: #fff; background: #9c3b3b; border-bottom-right-radius: 8px; }
    .du-ribbon.gold { background: #a8791c; }
    .du-ribbon.dim { background: #3d4655; }
    .du-lv { position: absolute; left: 8px; bottom: 8px; z-index: 2; font-size: calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold;
      color: #0c0f14; background: #ffd98c; border-radius: 4px; padding: 2px 9px; }

    /* ---- 收藏品卡（图像简化掉：用名称派生的色块代替图标）---- */
    .cc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(272px, 1fr)); gap: 9px; }
    .cc-card { display: flex; gap: 10px; padding: 9px 11px; border-radius: 7px;
      background: #171b23; border: 1px solid #2c333f; }
    .cc-card.medal { background: #1a1a24; border-color: #3a3550; }
    .cc-icon { flex: 0 0 38px; height: 38px; border-radius: 6px; display: flex; align-items: center;
      justify-content: center; font-size: calc(16px + var(--fs-d, 0px) + var(--fs-dl, 0px)); color: #0f1218; }
    .cc-meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .cc-nm { font-size: max(11px, calc(13px + var(--fs-d, 0px))); font-weight: bold; color: #ffd98c; word-break: break-all; }
    .cc-desc { font-size: max(11px, calc(11px + var(--fs-d, 0px))); color: #9aa3b0; line-height: 1.55; }
    .cc-foot { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 3px; }
    .cc-tag { font-style: normal; font-size: max(10px, calc(10px + var(--fs-d, 0px))); color: #9fe3ff; background: #1e2632;
      border-radius: 3px; padding: 1px 6px; }

    /* ---- 左栏详情 ---- */
    .dt-card { background: rgba(23,27,35,.82); border: 1px solid #2c333f; border-radius: 8px; overflow: hidden; }
    .dt-top { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
      background: linear-gradient(100deg, rgba(45,55,74,.55), rgba(23,27,35,0)); }
    .dt-top img { width: 56px; height: 56px; object-fit: contain; flex: 0 0 auto; }
    .dt-id { flex: 1 1 auto; min-width: 0; }
    .dt-name { display: block; font-size: calc(15px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold; color: #eef3fa; word-break: break-all; }
    .dt-state { display: block; font-size: max(11px, calc(11px + var(--fs-d, 0px))); color: #9aa3b0; margin-top: 5px; }
    .dt-state b { color: #7ec8ff; }
    .dt-tabs { display: flex; border-bottom: 1px solid #2c333f; }
    .dt-tab { flex: 1 1 0; padding: 8px 0; text-align: center; font-size: max(11px, calc(12px + var(--fs-d, 0px))); color: #8f99a8; cursor: pointer; }
    .dt-tab.on { color: #ffd98c; background: rgba(255,217,140,.07); box-shadow: inset 0 -2px 0 #ffd98c; }
    /* 标本库专用：精一/精二胸像临时查阅开关 */
    .dt-arts { display: flex; align-items: center; gap: 6px; padding: 7px 12px 0; flex-wrap: wrap; }
    .dt-art { font-family: inherit; font-size: max(11px, calc(11px + var(--fs-d, 0px))); padding: 3px 9px; cursor: pointer;
      color: #9aa3b0; background: #1c2029; border: 1px solid #39414f; border-radius: 5px; }
    .dt-art:hover { color: #e8e6e0; border-color: #6d7b92; }
    .dt-art.on { color: #ffd98c; border-color: rgba(255,210,92,.6); background: rgba(255,217,140,.08); }
    .dt-arthint { font-size: max(10px, calc(10px + var(--fs-d, 0px))); color: #6f7887; }
    /* 标本左栏的「✎ 改名」键（与精一/精二同一行，靠右） */
    .dt-btn { margin-left: auto; font-family: inherit; cursor: pointer; white-space: nowrap;
      font-size: max(11px, calc(11px + var(--fs-d, 0px))); padding: 3px 9px;
      color: #9fe3ff; background: #1c2029; border: 1px solid #39414f; border-radius: 5px; }
    .dt-btn:hover { color: #ffe9b8; border-color: rgba(255,210,92,.6); background: rgba(255,217,140,.08); }
    .dt-body { padding: 10px 12px 14px; }
    .dt-empty { color: #7b8595; font-size: max(11px, calc(13px + var(--fs-d, 0px))); line-height: 2; text-align: center; padding: 46px 12px; }
    .long-panel { position: fixed; right: 226px; bottom: calc(28% + 10px); width: 190px; z-index: 90;
      background: rgba(10,12,16,.86); border: 1px solid rgba(150,170,210,.28); border-radius: 8px; padding: 8px 10px;
      font-size: max(11px, calc(11px + var(--fs-d, 0px))); color: #cfd8e3; pointer-events: none; }
    .long-panel h4 { margin: 0 0 4px; color: #ffd98c; font-size: max(11px, calc(12px + var(--fs-d, 0px))); }
    /* 常驻三轴雷达：右下角那一条竖列的下段 —— 与聊天面板同底边(bottom: 0)、同高度(28%)，
       宽 244 + 右边距 8 = 252，正好与聊天面板让出的右侧条带(#chat-container right: 260px)同宽，
       于是底边对齐、两端平齐，看上去就是同一块底栏的右端。
       内容按列居中(flex)，不用固定像素高（内容多一档就自己往上长，永不裁切）。 */
    .radar-panel { position: fixed; right: 8px; bottom: 0; width: calc(var(--right-col) - 16px); height: 28%; min-height: 132px;
      z-index: 90; overflow: hidden;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      background: rgba(10,12,16,.86); border: 1px solid rgba(150,170,210,.28); border-radius: 8px;
      padding: 10px 14px; font-size: max(11px, calc(11px + var(--fs-d, 0px))); color: #cfd8e3; pointer-events: none; }
    .radar-panel h4 { margin: 0 0 2px; color: #ffd98c; font-size: max(11px, calc(12px + var(--fs-d, 0px))); text-align: center; letter-spacing: .5px; }
    .radar-panel > div { flex: 0 0 auto; line-height: 0; }
    .radar-panel > div:last-child { line-height: 1.4; text-align: center; margin-top: 4px; }
    /* 顶栏资源纯图案（无汉字）：核心生命=蓝瘦高梯形 / 源石=黄椭圆 / 精液=青绿三角 */
    .stat-item { display: inline-flex; align-items: center; gap: 6px; }
    .ic-trap { width: 10px; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 22px solid #4a90e2; }
    .ic-ellipse { width: 22px; height: 13px; border-radius: 50%; background: #ffd25c; }
    .ic-tri { width: 0; height: 0; border-left: 11px solid transparent; border-right: 11px solid transparent; border-bottom: 18px solid #2bb8a0; }
    /* 层数：顶边栏下方左侧的大号罗马数字（非 1~5 → X） */
    .layer-roman { position: fixed; top: calc(var(--bar-h) + 8px); left: 16px; z-index: 310; font-size: calc(38px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: bold;
      color: #ffd98c; line-height: 1; font-family: serif; text-shadow: 0 3px 10px rgba(0,0,0,.75); pointer-events: none; }
    #chat-container .chat-empty { flex: 1; margin: auto; color: #7f8a99; font-size: max(11px, calc(12px + var(--fs-d, 0px))); text-align: center; }
    /* 节点覆盖层：进节点即以整面角色背景盖住地图（默认 CG；后续用干员档案.背景） */
    #node-stage { position: fixed; top: var(--bar-h); left: 0; right: 0; bottom: calc(var(--vh) * 24); z-index: 40;
      background-size: cover; background-position: center; background-color: #0b0d12;
      transition: background-image .3s ease; }
    /* ===== 右侧选项卡（选牌式）：左缘渐淡、可滚动、点开互斥、再点确认 =====
       ⚠ 竖向分工：雷达占右下角那一条竖列的下段（与聊天面板同底边、同 28% 高）；
          选项栏从顶栏下方一直排到雷达上沿（bottom 停在 28vh+20px 之上），整条右侧列都归它。
       ⚠ 位置口径：上沿 top 由 30% 上提到 20%（整体上移约一屏的 10%），下沿同步上收同样的量。
       ⚠ 图层口径：rail 88 / 卡片 92 —— 高于聊天容器(50) 与节点 HUD(78)，低于顶栏(100)，
          卡片向左展开时压在聊天框之上。**不要再往上抬**：抬过 100 就会盖住顶栏，
          抬再高会和整页浏览器(460)/难度轮盘(200) 抢层级，得不偿失。
       ⚠ 裁切口径（关键）：栏留着 overflow-x: hidden，那是卡片左缘「渐淡」的来源；
          因此卡片的**最大宽度必须 ≤ 栏宽**（统一用 --rail-w / --card-w 两个变量驱动），
          一旦越界就会被自己这条 overflow 切掉左缘（曾出现展开卡被切半边、虚线轮廓断边）。 */
    #options-container { display: none; }
    #option-rail { --rail-w: 260px; --card-w: 252px; --card-exp: 320px;
      position: fixed; right: 0; top: 20%; bottom: max(calc(var(--vh) * 28 + 20px), 300px); width: var(--rail-w); z-index: 88;
      display: flex; flex-direction: column; align-items: flex-end; gap: 9px; padding: 8px 0;
      overflow-y: auto; overflow-x: hidden; scrollbar-width: none; pointer-events: auto; }
    #option-rail::-webkit-scrollbar { display: none; }
    .opt-card { position: relative; z-index: 92; box-sizing: border-box;
      width: min(var(--card-w), 100%); cursor: pointer; color: #e8e6e0;
      font-size: calc(15px + var(--fs-d, 0px) + var(--fs-dl, 0px)); font-weight: 600; letter-spacing: .6px; line-height: 1.4; text-align: right;
      background-color: rgba(22,27,36,.94);
      background-image: linear-gradient(to right, rgba(22,27,36,0) 0%, rgba(22,27,36,.86) 22%, rgba(24,29,38,.97) 58%);
      border: 1px solid rgba(150,170,210,.32); border-right: none; border-radius: 0;
      padding: 12px 16px 12px 20px; outline: none;
      transition: width .18s, transform .18s, border-color .2s, background-image .2s, background-color .2s; }
    .opt-card .d { display: block; font-size: max(11px, calc(12px + var(--fs-d, 0px))); font-weight: normal; letter-spacing: 0; color: #9aa3b0;
      margin-top: 3px; line-height: 1.5; }
    .opt-card:hover { border-color: rgba(255,210,92,.62); }
    /* 键盘 Tab 聚焦时才给细环，避免浏览器默认虚线轮廓破坏扁平观感 */
    .opt-card:focus-visible { outline: 1px solid rgba(255,210,92,.85); outline-offset: -2px; }
    /* 方向统一：所有卡片右缘都贴栏右缘，展开时只靠"变宽"向左探出（不做位移，避免任何越界裁切）。
       成长量：桌面 252→320（+68px）、小屏 208→250（+42px），两种视口下左缘都不越出栏边界。 */
    .opt-card.expanded { width: var(--card-exp);
      border-color: #ffd25c; font-size: calc(16px + var(--fs-d, 0px) + var(--fs-dl, 0px));
      background-color: rgba(33,39,53,.98);
      background-image: linear-gradient(to right, rgba(22,27,36,0) 0%, rgba(32,40,56,.95) 22%, rgba(34,40,56,1) 58%);
      box-shadow: 0 6px 22px rgba(0,0,0,.5); }

    /* ===== 诡意行商专用：商品「多选勾选态」 =====
       多选没有"展开＝确认位"这一步，所以不复用 .expanded（那是单选互斥的展开态）。
       勾选态用绿色描边 + 左缘 ✓ + 轻微加宽告知"已加入购物车"；再点一次即取消。
       ⚠ 宽度仍受 #option-rail 的 overflow-x: hidden 约束，故取 --card-exp（与展开态同宽，不越界）。 */
    .opt-card.shop-picked { width: var(--card-exp);
      border-color: #7bd88f; border-left: 3px solid #7bd88f;
      color: #eafff0; font-size: calc(16px + var(--fs-d, 0px) + var(--fs-dl, 0px));
      background-color: rgba(25,44,34,.98);
      background-image: linear-gradient(to right, rgba(22,27,36,0) 0%, rgba(28,52,40,.95) 22%, rgba(30,58,44,1) 58%);
      box-shadow: 0 6px 22px rgba(0,0,0,.5), inset 0 0 0 1px rgba(123,216,143,.18); }
    .opt-card.shop-picked::before { content: '✓'; position: absolute; left: 9px; top: 50%;
      transform: translateY(-50%); color: #7bd88f; font-size: max(11px, calc(12px + var(--fs-d, 0px)));
      font-weight: bold; letter-spacing: 0; pointer-events: none; }

    /* ===== 诡意行商「确认购买」按钮 =====
       位置**不是**写死在 CSS 里的：JS 每轮选项渲染后实测 #radar-panel 的矩形，写进 inline
       left/top/width/height（见 _syncShopBuyBtnPos）—— 于是按钮与三轴雷达**同位置同尺寸**，
       且底色全不透明，雷达被整块盖住、完全不可见（"全尺寸覆盖，挡住三轴雷达"）。
       下面这段 CSS 只是同一套位置口径的兜底：雷达不存在或极端布局下按钮仍贴右下角、仍可点。 */
    #shop-buy-btn { position: fixed; right: 8px; bottom: 0; width: calc(var(--right-col) - 16px); height: 132px;
      z-index: 96; box-sizing: border-box; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 6px; padding: 10px 12px;
      font-family: inherit; text-align: center; cursor: pointer;
      background: linear-gradient(160deg, #1e3d2c 0%, #16281e 44%, #0b0f0d 100%);
      border: 1px solid rgba(123,216,143,.55); border-radius: 8px; color: #eafff0;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.55), 0 8px 24px rgba(0,0,0,.55);
      transition: border-color .16s, box-shadow .16s, filter .16s; }
    #shop-buy-btn:hover { border-color: #ffd25c;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,.55), 0 8px 26px rgba(0,0,0,.6), 0 0 18px rgba(255,210,92,.26); }
    #shop-buy-btn:active { filter: brightness(1.14); }
    #shop-buy-btn:focus-visible { outline: 1px solid rgba(255,210,92,.85); outline-offset: -3px; }
    #shop-buy-btn .sb-cap { font-size: calc(17px + var(--fs-d, 0px) + var(--fs-dl, 0px));
      font-weight: bold; letter-spacing: 2px; color: #9df0b3; line-height: 1.2; }
    #shop-buy-btn .sb-sub { font-size: max(11px, calc(11px + var(--fs-d, 0px)));
      color: #8fa79a; line-height: 1.5; padding: 0 4px; }
    #shop-buy-btn.shop-empty .sb-cap { color: #7f8a99; }
    /* 生成期锁定：**绝不用 opacity** —— 半透明会让底下的三轴雷达透出来（违反"挡住令其不可见"）。
       改用亮度/饱和度压暗，视觉上仍是"不可点"，但仍保持全不透明。 */
    body.is-generating #shop-buy-btn { pointer-events: none; filter: saturate(.55) brightness(.62); }
    /* 紧凑档：与 .radar-panel 同一口径收窄（实际尺寸仍由 JS 实测覆盖） */
    body.ui-compact #shop-buy-btn { width: calc(var(--right-col) - 16px); height: 148px; }
    @media (max-width: 760px) { #shop-buy-btn { width: 200px; right: 8px; } }

    /* 诡意行商：顶端「离开节点」的两步选中态（选中商品会取消它，反之亦然 —— 互斥见 _shopPickLeave） */
    #node-leave-btn.shop-leave-picked { background: #b8860b; border: 1px solid #ffd25c; color: #fff4d6;
      box-shadow: 0 0 12px rgba(255,210,92,.42); }
    /* ⚠ 右侧让位改由「容器自身宽度」承担：#chat-container { right: 260px } 已经把整条竖列
       （雷达 + 选项卡）永久让出去了。这里**不能再加 padding-right**——否则等于让两遍，
       聊天记录会被推到左边、右侧留下一条谁也看不见的空带（曾出现空带 + 容器上沿戛然而止）。 */
    body.in-chat-left #option-rail { top: 18%; bottom: max(calc(var(--vh) * 28), 300px); }
    /* 小屏收窄右侧竖列（260→216），保证聊天底栏仍占「一大半宽」；雷达同步收窄保持两端平齐。
       卡片口径跟着栏宽同步收（展开态仍严格 ≤ 栏宽，不越界、不被裁）。 */
    @media (max-width: 760px) {
      #chat-container { right: 216px; }
      .radar-panel { width: 200px; right: 8px; }
      #option-rail { --rail-w: 216px; --card-w: 208px; --card-exp: 250px; }
      .opt-card { font-size: calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)); }
      .opt-card.expanded { font-size: calc(15px + var(--fs-d, 0px) + var(--fs-dl, 0px)); }
    }

    /* ===== 节点进入叠加过程动画（年份/生效收藏品/最终三轴） ===== */
    .stack-overlay { position: fixed; top: 62px; left: 50%; transform: translateX(-50%); z-index: 320; pointer-events: none; }
    .stack-box { background: rgba(10,12,16,.93); border: 1px solid rgba(150,170,210,.42); border-radius: 10px;
      padding: 12px 18px; box-shadow: 0 12px 32px rgba(0,0,0,.55); font-size: max(11px, calc(13px + var(--fs-d, 0px))); color: #e8e6e0;
      text-align: left; min-width: 280px; max-width: 86vw; }
    .stack-title { font-weight: bold; color: #ffd98c; font-size: calc(15px + var(--fs-d, 0px) + var(--fs-dl, 0px)); margin-bottom: 3px; }
    .stack-row { opacity: 0; animation: stackReveal .5s ease forwards; margin: 3px 0; }
    .stack-row b { color: #7ac8ff; }
    .stack-overlay.hide { transition: opacity .5s ease; opacity: 0; }
    @keyframes stackReveal { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    /* ===== 剧情日志播报卡（新增剧情 / 日志更新） =====
       与进节点战报同一套外观与位置（复用 .stack-overlay/.stack-box），区别：
       · z-index 480：要能被玩家点开时间轴页，而整页浏览器是 460 —— 卡片必须压在它上面；
       · 卡片本体可点击（pointer-events:auto），外层仍不挡操作。
       · 「更新」卡用**左右两块**（更新前 → 更新后）：每块与「新增」卡正文同宽，
         于是总宽度翻倍而高度不变，配合中间大箭头一眼看清改了什么。 */
    .chron-overlay { z-index: 480; }
    .chron-box { pointer-events: auto; cursor: pointer; }
    .chron-box.wide { max-width: 94vw; }
    .chron-tag { color: #8f99a8; font-size: max(10px, calc(11px + var(--fs-d, 0px))); font-weight: normal; }
    .chron-pair { display: flex; align-items: stretch; gap: 8px; margin-top: 6px; }
    /* flex:0 1 280px = 有空间就各占 280px（与新增卡正文同宽），空间不足则等比收缩；
       min-width:0 让长文本能换行而不是把卡片撑爆。 */
    .chron-cell { flex: 0 1 280px; min-width: 0; padding: 8px 10px; border-radius: 8px;
      border: 1px solid rgba(150,170,210,.28); background: rgba(255,255,255,.04);
      font-size: max(11px, calc(13px + var(--fs-d, 0px))); line-height: 1.65; word-break: break-word; }
    .chron-cell .ccap { display: block; margin-bottom: 4px; font-size: max(10px, calc(11px + var(--fs-d, 0px)));
      font-weight: bold; letter-spacing: 1px; }
    .chron-cell.old { color: #9aa3b2; border-color: rgba(150,170,210,.20); background: rgba(255,255,255,.02); }
    .chron-cell.old .ccap { color: #7f8899; }
    .chron-cell.new { color: #eef2f8; border-color: rgba(255,217,140,.42); background: rgba(255,217,140,.07); }
    .chron-cell.new .ccap { color: #ffd98c; }
    .chron-arrow { flex: 0 0 auto; align-self: center; color: #ffd98c; font-size: calc(20px + var(--fs-d, 0px));
      font-weight: bold; text-shadow: 0 0 10px rgba(255,217,140,.65); letter-spacing: -2px; }
    .chron-text { font-size: max(11px, calc(13px + var(--fs-d, 0px))); line-height: 1.7; word-break: break-word; }
    .chron-hint { margin-top: 6px; color: #6f7987; font-size: max(10px, calc(11px + var(--fs-d, 0px))); }
    body.ui-compact .chron-cell { flex-basis: 0; padding: 6px 8px; }

    /* ===== 历史时间轴整页（本局剧情日志，按泰拉历升序） ===== */
    .tl { position: relative; padding: 4px 2px 12px 4px; }
    .tl-item { position: relative; display: flex; padding: 0 0 16px 22px; }
    .tl-item::before { content: ''; position: absolute; left: 6px; top: 18px; bottom: 0; width: 2px;
      background: linear-gradient(180deg, rgba(150,170,210,.34), rgba(150,170,210,.14)); }
    .tl-item:last-child::before { display: none; }
    .tl-dot { position: absolute; left: 0; top: 8px; width: 14px; height: 14px; border-radius: 50%;
      background: #ffd98c; box-shadow: 0 0 10px rgba(255,217,140,.55); border: 1px solid rgba(255,255,255,.35); }
    .tl-body { min-width: 0; flex: 1 1 auto; }
    .tl-date { font-weight: bold; color: #ffd98c; letter-spacing: 1px;
      font-size: max(11px, calc(13px + var(--fs-d, 0px))); }
    .tl-text { color: #dfe4ec; line-height: 1.8; margin-top: 2px;
      font-size: max(11px, calc(13px + var(--fs-d, 0px))); word-break: break-word; }
    .tl-item.hi { background: rgba(255,217,140,.10); border-radius: 8px; }
    .tl-item.hi .tl-text { color: #fff; }

    /* ================= 干员开关面板（jczl_custom_switch · 女性向适配入口） ================= */
    /* z-index 500：必须盖过 #chat-expand(400)/gal层(200)/聊天面板(50) 等一切悬浮件；
       另由 body.custom-open 规则把 #chat-expand 整颗藏掉，杜绝它在面板里"悬在中间"。 */
    .custom-overlay { position: fixed; inset: 0; z-index: 500; display: flex; flex-direction: column;
      background: linear-gradient(180deg, rgba(9,11,16,0.98), rgba(13,17,24,0.99)); backdrop-filter: blur(3px); }
    body.custom-open #chat-expand { display: none !important; }
    .custom-head { flex: 0 0 auto; padding: 18px 22px 10px; text-align: center; font-size: calc(20px + var(--fs-d, 0px) + var(--fs-dl, 0px));
      font-weight: bold; color: #ffd98c; letter-spacing: 4px; }
    .custom-hint { display: block; margin: 6px auto 0; max-width: 680px; font-size: max(11px, calc(11px + var(--fs-d, 0px))); font-weight: normal;
      color: #8b95a6; letter-spacing: 0; line-height: 1.5; }
    .custom-search { display: block; margin: 12px auto 0; width: min(420px, 86vw); padding: 8px 14px; border-radius: 8px;
      border: 1px solid rgba(140,160,200,0.3); background: rgba(18,22,30,0.8); color: #e8eef8;
      font-size: max(12px, calc(13px + var(--fs-d, 0px))); outline: none; }
    .custom-actions { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .custom-stat { text-align: center; color: #9aa3b0; font-size: max(11px, calc(11px + var(--fs-d, 0px))); margin-top: 10px; }
    .custom-status { text-align: center; min-height: 20px; color: #7ac8ff; font-size: max(11px, calc(12px + var(--fs-d, 0px))); margin-top: 4px; }
    .custom-status.bad { color: #ff8080; }
    .custom-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 22px 26px; display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 6px; align-content: start; }
    .custom-row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border: 1px solid rgba(140,160,200,0.16);
      border-radius: 8px; background: rgba(18,22,30,0.55); transition: 0.15s; }
    .custom-row.off { opacity: 0.5; filter: grayscale(0.5); }
    .custom-ava { width: 44px; height: 44px; object-fit: contain; border-radius: 6px; background: rgba(0,0,0,0.3); flex: 0 0 auto; }
    .custom-name { flex: 1 1 auto; font-size: calc(14px + var(--fs-d, 0px) + var(--fs-dl, 0px)); color: #e8eef8; text-align: left; }
    .custom-gender { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 10px; font-size: max(10px, calc(10px + var(--fs-d, 0px)));
      color: #b9c2d0; background: rgba(120,150,200,0.16); vertical-align: 2px; }
    /* 「工坊」= 该名字来自创意工坊自定义池（jczl_custom_pool），不是内置 PoolDB（两套来源必须一眼分得清） */
    .custom-src { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 10px; font-size: max(10px, calc(10px + var(--fs-d, 0px)));
      color: #ffd98c; background: rgba(220,180,90,0.18); border: 1px solid rgba(255,210,92,0.34); vertical-align: 2px; }
    .custom-switch { position: relative; width: 44px; height: 24px; flex: 0 0 auto; cursor: pointer; }
    .custom-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 2; }
    .cs-slider { position: absolute; inset: 0; border-radius: 12px; background: rgba(60,66,78,0.9); border: 1px solid rgba(140,160,200,0.3); transition: 0.18s; }
    .cs-slider::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
      background: #cfd8e3; transition: 0.18s; }
    .custom-switch input:checked + .cs-slider { background: rgba(120,170,120,0.55); border-color: rgba(140,220,160,0.6); }
    .custom-switch input:checked + .cs-slider::after { left: 22px; background: #d8fff0; }
    .custom-empty { grid-column: 1 / -1; text-align: center; color: #8b95a6; padding: 30px 0; }

    /* ===================================================================
       〘窄屏输入面板〙#input-strip（竖条开关）+ #input-popup（完整输入界面）
       背景：手机横屏（紧凑档 body.ui-compact）里，常驻输入行吃掉底栏一整条高度，
             正文窗、编队页、难度轮盘都被它往下顶。所以紧凑档把输入行整行移出布局
             （见 compactStyles ⑨），只留正文窗贴底；腾出来的那一行高度里，
             右列收窄后在左侧留出一条**竖条** #input-strip。
       交互：点竖条 → #input-popup 从右侧滑出，**尺寸与位置完全等于正文窗**
             （JS 实测 #gal-layer 矩形写进 inline，见 _layoutInputPopup）；
             真正的输入行（#chat-input-area）整块搬进面板里，事件绑定原样保留；
             点竖条 / 面板右上角 ✕ / 任意一次发送成功 → 收起，输入行搬回 #chat-container。
       ⚠ 基础规则里两个节点恒为 display:none：桌面档永远看不见它们，桌面排版逐像素不变。 */
    #input-strip { display: none; }
    #input-popup { display: none; }
    #input-popup.on { display: block; position: fixed; z-index: 260; box-sizing: border-box;
      background: linear-gradient(180deg, rgba(10,13,19,.975), rgba(6,8,12,.99));
      border-top: 1px solid rgba(255,210,92,.45); border-right: 1px solid rgba(150,170,210,.24);
      border-radius: 0 10px 0 0; box-shadow: 0 -12px 34px rgba(0,0,0,.62);
      animation: inputPopIn .2s ease-out both; }
    @keyframes inputPopIn { from { opacity: 0; transform: translateX(26px); } to { opacity: 1; transform: none; } }
    /* 面板里的输入行：**左边一整块大输入框；右边＝目标选择框盖在三个按钮上面**。
       作者口径：目标选择框宽度 = 发送/↻/■ 三个按钮之和，四件一起占满面板高度，
       省下的宽度全部留给左边输入框。
       实现：用 CSS grid 而不是包一层 div —— 这样 DOM 结构完全不变，
       底部常驻输入行（桌面档/竖屏手机）仍是原来那个单行 flex，不会被打乱。
         · 第 1 列（1fr）= 输入框，横跨两行 → 一整块；
         · 第 2~4 列 = 三个按钮，留在第 2 行；
         · 目标选择框横跨第 2~4 列、待在第 1 行 → 宽度天然等于三按钮之和。 */
    #input-popup #chat-input-area { display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      grid-template-rows: 1fr 1fr;
      align-items: stretch; gap: 8px;
      width: 100%; height: 100%; box-sizing: border-box;
      padding: 27px 12px 10px; background: none; border-top: none; overflow: hidden; }
    #input-popup #chat-input { grid-column: 1; grid-row: 1 / span 2; min-width: 0;
      padding: 8px 12px; font-size: max(13px, calc(15px + var(--fs-d, 0px))); }
    #input-popup #target-selector { grid-column: 2 / span 3; grid-row: 1;
      width: 100%; max-width: none; padding: 0 6px;
      font-size: max(11px, calc(12px + var(--fs-d, 0px))); }
    #input-popup #chat-send { grid-column: 2; grid-row: 2; }
    #input-popup #chat-reroll { grid-column: 3; grid-row: 2; }
    #input-popup #chat-stop { grid-column: 4; grid-row: 2; }
    #input-popup #chat-send, #input-popup #chat-reroll, #input-popup #chat-stop {
      padding: 0 14px; display: inline-flex; align-items: center; justify-content: center; }
    #input-popup #chat-send { font-size: max(12px, calc(14px + var(--fs-d, 0px))); }
    #input-popup-close { position: absolute; right: 10px; top: 4px; z-index: 2;
      min-width: 28px; height: 18px; padding: 0 8px; white-space: nowrap;
      display: flex; align-items: center; justify-content: center; cursor: pointer;
      font-family: inherit; font-size: max(10px, calc(10px + var(--fs-d, 0px))); line-height: 1;
      color: #cfd8e6; background: rgba(18,23,32,.92); border: 1px solid rgba(150,170,210,.34);
      border-radius: 5px; }
    #input-popup-close:hover { color: #ffe0a0; border-color: rgba(255,210,92,.7); }
    /* 生成中锁定：面板里的发送/重roll 与底部输入行同一套封锁口径 */
    body.is-generating #input-popup #chat-send, body.is-generating #input-popup #chat-reroll {
      pointer-events: none; opacity: .45; filter: saturate(.6); }
    /* 面板打开时藏掉「展开对话记录」那颗（z 400，否则会浮在面板顶边上） */
    body.input-open #chat-expand { display: none !important; }

    /* ===================================================================
       〘编队两步页的大画布〙body.in-prep（分队选牌 + 基底干员）
       为什么：这两页画在 #stage 里，会被正文窗(#gal-layer z200)与聊天面板(z50)压住一块；
             干员一多，内容还会同时顶出上下边界（#main-content 原本 flex 居中，两头都被切）。
       做法：· 舞台吃满整屏高度（bottom:0），内容区变成**可滚动 / 可拖曳的大画布**；
             · 底部留出 42vh 余量 —— 被正文窗盖住的最后一行按钮，往上拖就能整块露出来；
             · 触屏走原生滚动，鼠标按住画面即可拖（见 _bindPrepPan）；
             · 子元素不再居中被裁：display:block + margin auto，超宽/超高都能拖到。
       ⚠ 只在这两步页生效（switchView 里切 body.in-prep），其它视图一行不受影响。 */
    body.in-prep #stage { bottom: 0; }
    body.in-prep #main-content { display: block; overflow: auto;
      padding: 6px 10px calc(var(--vh) * 42 + 16px);
      touch-action: pan-x pan-y; cursor: grab; scrollbar-width: thin;
      scrollbar-color: rgba(150,170,210,.34) transparent; }
    body.in-prep #main-content.panning { cursor: grabbing; }
    body.in-prep #main-content.panning * { cursor: grabbing !important; }
    body.in-prep #main-content > * { margin: 0 auto; }

    /* ===== 编队页 · 标本库按时间线挑选 =====
       老做法是把全库干员平铺成一整片 .op-grid：时间线信息丢了，人一多就无限撑高，
       把「确认并出发」顶出屏幕。现在改成：一行横向滚动的**时间线名字**（默认能看到几个，
       其余滑动翻出），点一个名字才在下方展开它里面的干员（同时只展开一条）。
       名字优先用玩家在标本室起的自定义名（$时间线名称，只读显示），没起名就显示 #编号。 */
    .prep-tl-hint { color: #8b95a6; font-weight: normal; font-size: max(10px, calc(11px + var(--fs-d, 0px))); }
    .prep-tl-bar { display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden; padding: 2px 2px 8px;
      margin-top: 2px; scrollbar-width: none; -ms-overflow-style: none; }
    .prep-tl-bar::-webkit-scrollbar { width: 0; height: 0; background: transparent; }
    .prep-tl { flex: 0 0 auto; max-width: 190px; display: inline-flex; align-items: baseline; gap: 5px;
      padding: 7px 12px; border-radius: 999px; cursor: pointer; font-family: inherit;
      font-size: max(11px, calc(13px + var(--fs-d, 0px))); color: #cfd8e3; white-space: nowrap;
      background: rgba(20,25,34,.9); border: 1px solid rgba(150,170,210,.34);
      transition: color .15s, border-color .15s, background .15s; }
    .prep-tl .ptl-nm { max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
    .prep-tl .ptl-n { color: #8f99a8; font-size: max(9px, calc(10px + var(--fs-d, 0px))); }
    .prep-tl:hover { color: #ffe6b0; border-color: rgba(255,210,92,.6); }
    .prep-tl.on { color: #ffe6b0; border-color: #ffd25c; background: rgba(255,210,92,.14);
      box-shadow: inset 0 0 0 1px rgba(255,210,92,.18); }
    .prep-tl.on .ptl-n { color: #ffd98c; }
    .prep-tl.anomaly { border-style: dashed; color: #ffb0a0; }
    .prep-tl-body { min-height: 96px; }
    /* 已被选为基底的那张卡：金边 + 勾（和「随机出身」抽到的同一套视觉） */
    .op-card.picked { border-color: #ffd25c; background: rgba(255,210,92,.14);
      box-shadow: inset 0 0 0 1px rgba(255,210,92,.22); }
    .op-card.picked::after { content: '✓'; position: absolute; right: 3px; top: 2px; color: #ffd25c;
      font-size: max(10px, calc(11px + var(--fs-d, 0px))); font-weight: bold; pointer-events: none; }

  `;

  // =========================================================================================
  // 【手机端紧凑档 compactStyles】—— 唯一入口：body.ui-compact（判定见 applyUiDensity）
  //   · 生效条件：触屏（pointer:coarse / hover:none）**且** iframe 视口高 ≤ 640px。
  //     手机横屏（约 873×393）命中；桌面鼠标/触控板永不命中 → 电脑端排版逐像素不变。
  //   · 只改「布局尺寸」，不改任何颜色/层级/交互逻辑；字体统一 -2px 由 --fs-d 令牌实现。
  //   · 全部规则追加在样式表最末，且带 body.ui-compact 前缀（同权重时后者胜、异权重时更高），
  //     因此不需要 !important，也不会污染上面的桌面口径。
  //   · 与视图类（.in-map / .in-chat-left）组合时用 body.ui-compact.in-map 提高优先级，
  //     需要"排除某视图"时用 :not(.in-chat-left)，避免把 in-chat-left 的 right:auto 顶掉。
  //   · 手动开关：Shift+M 循环 自动→桌面→紧凑（localStorage: jczl.uiDensity），
  //     也可用 ?jczl_ui=desktop|compact 强制一档。
  // =========================================================================================
  const compactStyles = `
    /* ---- ⓪ 令牌覆盖：这里就是"密度旋钮"本体 ---- */
    body.ui-compact { --fs-d: -2px; --fs-dl: -1px; --bar-h: 30px; --right-col: 176px;
      background-attachment: scroll; }   /* 移动端 fixed 背景会持续重绘，换成 scroll */

    /* ---- ① 顶栏：高度 48→34、按钮全部收一档（字号由 --fs-d 统一 -2px）---- */
    body.ui-compact #top-bar { padding: 0 8px; gap: 5px; }
    body.ui-compact .stat-item { margin: 0 7px 0 0; gap: 4px; }
    body.ui-compact .ic-trap { width: 7px; border-left-width: 6px; border-right-width: 6px;
      border-bottom-width: 16px; }
    body.ui-compact .ic-ellipse { width: 16px; height: 10px; }
    body.ui-compact .ic-tri { border-left-width: 8px; border-right-width: 8px; border-bottom-width: 13px; }
    body.ui-compact .top-drop { padding: 4px 10px 4px 17px; border-radius: 5px; }
    body.ui-compact .top-drop::before { left: 7px; }
    body.ui-compact #top-bar .top-btn { min-width: 54px; padding: 5px 10px; letter-spacing: .6px; }

    /* ---- ② 底部三条带：聊天 / Galgame / 雷达（高度全部按「矮视口」重算）---- */
    /* ⚠ 两处 :not(.in-chat-left)：棋盘类界面里 #stage 是 bottom:0、聊天是竖排整列，
       紧凑档不能把它们按"底栏 22%"重算，否则棋盘会被压掉一条。 */
    body.ui-compact:not(.in-chat-left) #stage { bottom: 22%; }
    body.ui-compact:not(.in-chat-left) #chat-container { right: var(--right-col); height: 22%; }
    body.ui-compact:not(.in-chat-left) #chat-container.expanded { height: 84%; }
    body.ui-compact #chat-history { padding: 7px 11px 6px; gap: 7px; }
    body.ui-compact .chat-msg { max-width: 88%; }
    body.ui-compact .chat-bubble { padding: 7px 11px; border-radius: 10px; line-height: 1.55; }
    body.ui-compact .chat-more-btn { margin: 4px 0; padding: 5px 11px; }
    body.ui-compact #chat-input-area { padding: 7px 10px; gap: 6px; }
    body.ui-compact #target-selector { padding: 5px 6px; max-width: 92px; }
    body.ui-compact #chat-input { padding: 6px 10px; }
    body.ui-compact #chat-send { padding: 6px 12px; }
    body.ui-compact #chat-stop, body.ui-compact #chat-reroll { padding: 6px 9px; }
    body.ui-compact:not(.in-chat-left) #chat-expand { width: 58px; height: 22px;
      top: calc(var(--vh) * 100 - var(--vh) * 22 - 22px); }
    body.ui-compact:not(.in-chat-left) #chat-container.expanded ~ #chat-expand {
      top: calc(var(--vh) * 100 - var(--vh) * 84 - 22px); }
    body.ui-compact #gal-layer { right: var(--right-col); bottom: 46px;
      height: 30%; min-height: 112px; }
    body.ui-compact #gal-box { padding: 0 0 9px; }
    body.ui-compact #gal-body { margin: 0 10px; padding: 15px 12px 8px 78px;
      min-height: 92px; line-height: 1.62; }
    body.ui-compact #gal-avatar { width: 54px; height: 54px; left: 9px; bottom: 32px; }
    body.ui-compact #gal-name { left: 74px; top: -12px; padding: 3px 10px; min-width: 70px;
      letter-spacing: .8px; }
    body.ui-compact #gal-back, body.ui-compact #gal-next { width: 26px; height: 26px; bottom: 6px; }
    body.ui-compact #gal-back { left: 9px; }
    body.ui-compact #gal-next { right: 10px; }
    body.ui-compact #gal-pager { bottom: 8px; letter-spacing: 1px; }
    body.ui-compact #gal-float { right: 10px; bottom: 100%; max-width: 92%; }
    body.ui-compact #gal-float .gal-you { padding: 5px 10px; max-height: 3.4em; }
    /* ⚠ 必须带 #gal-body：基础规则是「#gal-body .gal-grp」（1 个 id），
       用 body.ui-compact .gal-grp 反而权重更低、压不住 30vh 的旧值 */
    body.ui-compact #gal-body .gal-grp { max-height: calc(var(--vh) * 24); }
    /* 雷达面板：紧凑档改成"按内容自适应高度"。
       面板内容是 固定 120×116 的带顶点标注 SVG + 标题 + 去量化/所知三行，
       硬塞进 22%(≈86px) 会把图上下裁掉（"未来/过往/现实"标注看不见）。
       高度交给内容（约 148~164px），与 #option-rail 的 bottom:168px 正好衔接。 */
    body.ui-compact .radar-panel { width: calc(var(--right-col) - 16px); height: auto;
      min-height: 148px; padding: 5px 8px; gap: 0; }
    body.ui-compact .long-panel { right: calc(var(--right-col) + 4px); width: 132px;
      bottom: calc(22% + 8px); }
    /* 棋盘类界面（in-chat-left）：手机上给棋盘多让一点宽 */
    body.ui-compact.in-chat-left #chat-container { width: 30%; }
    body.ui-compact.in-chat-left #chat-container.expanded { width: 72%; }
    body.ui-compact.in-chat-left #main-content { padding-left: 30%; }

    /* ---- ③ 地图：节点 152→112（原占屏高 39%，现约 28%）、列间距同步收 ---- */
    body.ui-compact.in-map .map-node { width: 112px; height: 112px; }
    body.ui-compact.in-map .map-col { gap: 14px; }
    body.ui-compact.in-map .map-inner { gap: 70px; padding: 20px 34px 58px; }
    /* 层数罗马数字：装饰性字形，紧凑档直接给固定小值（原本 38px→35px 仍占掉近 1/10 屏高） */
    body.ui-compact .layer-roman { top: calc(var(--bar-h) + 4px); left: 8px; font-size: 26px; }
    body.ui-compact #node-stage { bottom: calc(var(--vh) * 20); }

    /* ---- ④ 右侧选项卡栏：栏宽/卡宽跟 --right-col 走；下沿不再被 300px 硬底顶死 ---- */
    /* ⚠ 下沿 168px 是"雷达加高后"的上沿：雷达在紧凑档按内容自适应（约 148~164px），
       选项卡栏必须停在它上面，否则卡片会被雷达压住。 */
    body.ui-compact #option-rail { --rail-w: var(--right-col);
      --card-w: calc(var(--right-col) - 8px); --card-exp: calc(var(--right-col) + 34px);
      top: 16%; bottom: max(calc(var(--vh) * 18), 168px); gap: 6px; padding: 6px 0; }
    body.ui-compact.in-chat-left #option-rail { top: 14%; bottom: max(calc(var(--vh) * 18), 168px); }
    body.ui-compact .opt-card { padding: 8px 10px 8px 14px; }
    body.ui-compact .opt-card .d { margin-top: 2px; }

    /* ---- ⑤ 整页浏览器：干员编队 / 标本库 / 收藏品库 ---- */
    /* 卡片"被拉成整屏宽、右边一大片空白"的根因：auto-fill + 1fr 在窄容器里只排出 1 条轨道，
       轨道又被 1fr 撑满。紧凑档改成**有上限的轨道宽**（330px），一行能排 2 张就排 2 张，
       排不下就单列 330px —— 卡片永远是"卡片"，不会被拉宽。 */
    body.ui-compact .pg-head { padding: 6px 10px; gap: 8px; }
    body.ui-compact .pg-side { flex: 0 0 min(30%, 244px); padding: 8px 8px 14px; }
    body.ui-compact .pg-main { padding: 8px 10px 18px; }
    body.ui-compact .pg-empty { padding: 20px 10px; line-height: 1.7; }
    body.ui-compact .du-grid { grid-template-columns: repeat(auto-fill, minmax(min(288px, 100%), 330px));
      justify-content: start; gap: 8px; }
    body.ui-compact .du-card { height: clamp(104px, calc(var(--vh) * 36), 168px); }
    body.ui-compact .du-art { flex: 0 0 88px; }
    body.ui-compact .du-meta { gap: 5px; padding: 7px 9px 7px 7px; }
    body.ui-compact .du-nums { gap: 3px; }
    body.ui-compact .du-ribbon { padding: 3px 9px 3px 7px; }
    body.ui-compact .du-lv { left: 6px; bottom: 6px; padding: 1px 7px; }
    body.ui-compact .cc-grid { grid-template-columns: repeat(auto-fill, minmax(min(210px, 100%), 260px));
      justify-content: start; gap: 7px; }
    body.ui-compact .cc-icon { flex: 0 0 30px; height: 30px; }
    body.ui-compact .cc-card { padding: 7px 9px; gap: 8px; }
    body.ui-compact .dt-top { padding: 8px 10px; }
    body.ui-compact .dt-top img { width: 44px; height: 44px; }
    body.ui-compact .dt-tab { padding: 6px 0; }
    body.ui-compact .dt-body { padding: 8px 10px 12px; }
    body.ui-compact .dt-empty { padding: 24px 10px; }
    body.ui-compact .dt-arts { padding: 6px 10px 0; }
    /* 标本室折叠树：紧凑档把行头收紧、元信息换行让位（手机上标题 + 开关必须都够按） */
    body.ui-compact .sp-head { padding: 8px 9px; gap: 7px; flex-wrap: wrap; }
    body.ui-compact .sp-title { font-size: max(11px, calc(13px + var(--fs-d, 0px))); }
    body.ui-compact .sp-meta { font-size: max(10px, calc(11px + var(--fs-d, 0px))); }
    body.ui-compact .sp-body { padding: 2px 9px 8px; }
    body.ui-compact .sp-subhead { padding: 6px 2px; font-size: max(10px, calc(12px + var(--fs-d, 0px))); }
    body.ui-compact .sp-sub.open > .sp-subbody > .tl,
    body.ui-compact .sp-sub.open > .sp-subbody > .du-grid { margin-left: 8px; }
    body.ui-compact .sp-tgl { width: 38px; height: 20px; }
    body.ui-compact .sp-knob { width: 14px; height: 14px; }
    body.ui-compact .sp-tgl.on .sp-knob { left: 21px; }
    body.ui-compact .sp-rename { width: min(180px, 42vw); font-size: max(11px, calc(13px + var(--fs-d, 0px))); }
    body.ui-compact .sp-edit { opacity: .8; padding: 2px 6px; }

    /* ---- ⑥ 开局 / 难度轮盘 / 弹窗 / 通用面板：一律给「矮视口」留出内部滚动 ---- */
    /* 分队页：标题/选牌/说明三段的上下留白整体收掉，
       牌宽保持 158（5 张刚好铺满 873），只压高度，不压字号可读性（12/13px 已保底 11px）。
       按钮已移出 .sq-view 的纵向流（见基础样式 .sq-btns → 右下角操作列），
       这里不再需要底部让位，整屏高度全部让给卡片。 */
    body.ui-compact .sq-view { padding-top: var(--bar-h); }
    body.ui-compact .sq-title { padding: 6px 0 2px; letter-spacing: 3px; }
    body.ui-compact .sq-scroll { gap: 8px; padding: 2px 12px 4px; overflow-y: auto; }
    body.ui-compact .sq-card { flex: 0 0 158px; height: min(100%, 240px); gap: 4px; padding: 8px 7px; }
    /* 图标：SVG 是 width/height=72 的定值（squadIconSVG(s.图标,72)），只压容器高并不管用，
       必须直接改 svg 尺寸（有 viewBox，等比缩放）。54 的容器高也要跟着收，否则又是溢出。 */
    body.ui-compact .sq-card .sq-icon { height: 42px; }
    body.ui-compact .sq-card .sq-icon svg { width: 40px; height: 40px; }
    body.ui-compact .sq-tip { padding: 0 2px; }
    body.ui-compact .sq-btns { gap: 8px; }
    /* 「返回 / 确认编队」：整体再小 1/3（字号 20→-3 后是 17，这里直接给 13 + 收 padding） */
    body.ui-compact .sq-btns .big-btn { padding: 5px 11px; font-size: 13px; border-radius: 5px; }
    body.ui-compact .diff-wheel-head { padding: 10px 14px 4px; letter-spacing: 2px; }
    body.ui-compact .dw-arrow { height: 28px; }
    /* 行高下限 66 与 JS（_openDifficultyWheel 的 layoutWheel）保持一致；
       注意 JS 会写 inline height，这里的值只作首帧兜底。 */
    body.ui-compact .dw-item { min-height: 66px; height: 66px; padding: 7px 13px; gap: 4px; }
    body.ui-compact .dw-num { min-width: 48px; }
    body.ui-compact .dw-effs { padding-left: 62px; }
    body.ui-compact .diff-wheel-foot { padding: 10px 16px 14px; gap: 10px; }
    body.ui-compact .home-deco { max-width: 92vw; }
    /* 主城右下角操作列（继承基础样式的位置：右缘 8px、宽 = --right-col - 16 = 160px）：
       同一行里塞「出门探索 + 难度键」必须两边都收一点，否则按钮文字会被挤到换行。 */
    body.ui-compact .home-side { gap: 6px; }
    body.ui-compact .home-go-row { gap: 6px; }
    body.ui-compact .home-go-row .big-btn { padding: 7px 9px; font-size: 15px; white-space: nowrap; }
    body.ui-compact .diff-num-btn { width: 42px; height: 42px; margin-left: 0; }
    body.ui-compact .diff-num-btn .dnb-num { line-height: 1; }
    body.ui-compact .big-btn { padding: 9px 16px; border-radius: 5px; }
    body.ui-compact .view-panel { padding: 14px; min-width: min(92vw, 320px); max-width: 92vw; }
    body.ui-compact .row { gap: 8px; margin-top: 10px; }
    body.ui-compact .modal-box { padding: 14px 16px; max-width: min(92vw, 420px);
      max-height: 86%; overflow-y: auto; }
    body.ui-compact .modal-btns { margin-top: 12px; gap: 8px; }
    body.ui-compact .modal-btn { padding: 7px 14px; }
    body.ui-compact .panel-box { padding: 10px 12px; max-height: 88%; }
    body.ui-compact .top-drop-panel { padding: 10px; gap: 6px; max-height: calc(var(--vh) * 74); }
    body.ui-compact .op-cqcard { width: 168px; padding: 8px; gap: 4px; }
    body.ui-compact .op-cqcard .cq-head img { width: 36px; height: 36px; }
    body.ui-compact .op-card { width: 72px; padding: 4px; }
    body.ui-compact .op-card img { width: 44px; height: 44px; }
    body.ui-compact .dp-grid { gap: 7px; }
    body.ui-compact .dev-btn { padding: 6px 10px; }
    body.ui-compact #dev-panel { padding: 10px; }
    body.ui-compact .stack-overlay { top: calc(var(--bar-h) + 8px); }
    body.ui-compact .stack-box { min-width: 240px; padding: 9px 13px; }
    body.ui-compact .title-splash { letter-spacing: 7px; }

    /* ---- ⑦ 触屏可达性：hover 才显形的东西（消息级 🔄🗑️）在手机上默认摸不到 ---- */
    body.ui-compact .msg-controls { opacity: .92; }
    body.ui-compact .ctrl-btn { padding: 3px 7px; }

    /* ---- ⑧ 密度开关按钮：只在「触屏 + 手机/平板尺寸」出现（桌面浏览器 never 创建）----
       用途：手机上按不到 Shift+M，需要在屏幕上有一个能点回来的入口。
       位置刻意选在顶栏下方右上角 —— 那里在紧凑档里是空的（选项卡栏从 16% 才开始）。 */
    body.ui-touch #ui-density-chip { position: fixed; top: calc(var(--bar-h, 48px) + 3px); right: 5px;
      z-index: 330; font-size: max(11px, calc(12px + var(--fs-d, 0px))); line-height: 1; padding: 5px 8px;
      color: #cfd8e6; background: rgba(10,13,18,.72); border: 1px solid rgba(151,178,216,.32);
      border-radius: 5px; opacity: .5; cursor: pointer; user-select: none; -webkit-user-select: none;
      transition: opacity .16s, color .16s, border-color .16s; }
    body.ui-touch #ui-density-chip:hover, body.ui-touch #ui-density-chip:active {
      opacity: 1; color: #ffe0a0; border-color: rgba(255,210,92,.7); }

    /* =====================================================================
       ⑨ 窄屏底栏改版（作者口径：只影响紧凑档）：
          · 常驻输入行整行移出布局 → 正文窗**尺寸不变**、整体下移贴底，
            于是底栏高度少掉整整一个输入行（约 46px）；
          · 右列（三轴雷达 / 诡意行商「确认购买」/ 首页操作列 / 编队按钮列）宽度收到 --cluster-w，
            高度与正文窗同高 → 右列左侧空出一条竖条，放「展开输入」按钮；
          · 点竖条弹出的 #input-popup 与正文窗**同尺寸同位置**（JS 实测正文窗矩形写入）。
       两个旋钮：--gal-h（底栏高度基准 = 正文窗高度）/ --cluster-w（右列簇宽度）。
       ⚠ 高度一律写 max(--gal-h, 112px)：正文窗自己有 min-height:112px，
          屏幕特别矮时它撑到 112，右列必须跟着撑，否则两者不再齐平。
       ⚠ 雷达**不缩画幅**：只重排文字（隐标题、未来键值并排、过往/现实上移到两底角、viewBox 裁到内容），
          几何见 _radarSVGLabeled 的 compact 分支。
       ⚠ 桌面档一条都不命中（全部带 body.ui-compact 前缀），电脑端排版逐像素不变。 */
    body.ui-compact { --gal-h: calc(var(--vh) * 30); --cluster-w: 124px; }

    /* ① 输入行移出常驻布局：底栏只剩正文窗，且正文窗贴底 */
    body.ui-compact:not(.in-chat-left) #chat-container > #chat-input-area { display: none; }
    body.ui-compact:not(.in-chat-left) #chat-container:not(.expanded) { pointer-events: none; }
    body.ui-compact:not(.in-chat-left) #gal-layer { bottom: 0 !important; height: var(--gal-h); }

    /* ② 右列簇：宽度收窄、高度与正文窗齐平
       ⚠ 雷达**不缩画幅**（三角几何见 _radarSVGLabeled 的 compact 分支，半径仍是 38），
         省高度全靠重排文字：
         · 隐掉 h4 标题，省一行；
         · SVG 按 120:88 的比例给 104 宽、高度自动（viewBox 已裁到内容范围，不再有上下空边）；
         · 「去量化 / 所知」回到正常流里、排在图形下方 → 绝不可能再压到顶点数值上。 */
    body.ui-compact .radar-panel { width: var(--cluster-w); height: max(var(--gal-h), 112px); min-height: 0;
      padding: 3px 4px; border-radius: 7px; gap: 1px; }
    body.ui-compact .radar-panel h4 { display: none; }
    body.ui-compact .radar-panel > div { line-height: 1; }
    body.ui-compact .radar-panel svg { width: 104px; height: auto; display: block; margin: 0 auto; }
    body.ui-compact .radar-panel .rp-nums { margin-top: 0;
      font-size: max(9px, calc(10px + var(--fs-d, 0px))); line-height: 1.25; }
    body.ui-compact .radar-panel .rp-enemy { margin-top: 0;
      font-size: max(9px, calc(10px + var(--fs-d, 0px))); line-height: 1.25; }
    body.ui-compact #shop-buy-btn { width: var(--cluster-w); height: max(var(--gal-h), 112px); }
    body.ui-compact .home-side { width: var(--cluster-w); gap: 5px; }
    body.ui-compact .sq-btns { width: var(--cluster-w); gap: 7px; }
    /* 首页操作列 / 编队按钮列跟着收窄：字号与内边距一起降一档，保证文字仍在按钮里 */
    body.ui-compact .home-side .big-btn { padding: 7px 6px; font-size: 13px; letter-spacing: 0;
      white-space: nowrap; }
    body.ui-compact .home-go-row { gap: 5px; }
    body.ui-compact .home-go-row .big-btn { padding: 7px 6px; font-size: 13px; }
    body.ui-compact .diff-num-btn { width: 34px; height: 34px; }
    body.ui-compact .diff-num-btn .dnb-cap { font-size: 9px; letter-spacing: 0; }
    body.ui-compact .sq-btns .big-btn { padding: 6px 8px; font-size: 13px; }
    body.ui-compact .home-short-row { padding: 5px 7px; }
    body.ui-compact .home-short-row .hs-label { font-size: max(11px, calc(12px + var(--fs-d, 0px))); }
    body.ui-compact .home-short-row .hs-switch { width: 40px; height: 20px; }
    body.ui-compact .home-short-row .hs-knob { width: 14px; height: 14px; }
    body.ui-compact .home-short-row.on .hs-knob { left: 23px; }
    /* 右侧竖列的下沿统一停在新的底簇上沿（选项卡栏 / 长期池面板） */
    body.ui-compact #option-rail { bottom: calc(max(var(--gal-h), 112px) + 8px); }
    body.ui-compact.in-chat-left #option-rail { bottom: calc(max(var(--gal-h), 112px) + 8px); }
    body.ui-compact .long-panel { bottom: calc(max(var(--gal-h), 112px) + 8px); }

    /* ③ 展开输入竖条：夹在正文窗右缘与右列簇之间
          宽 = --right-col − --cluster-w − 20px（176−124−20 = 32px，两边各留 8/4px 缝） */
    body.ui-compact #input-strip { display: flex; position: fixed; z-index: 210;
      right: calc(var(--cluster-w) + 12px); bottom: 0;
      width: calc(var(--right-col) - var(--cluster-w) - 20px); height: max(var(--gal-h), 112px);
      align-items: center; justify-content: center; padding: 0; cursor: pointer;
      font-family: inherit; font-size: max(11px, calc(12px + var(--fs-d, 0px))); letter-spacing: 3px;
      color: #cfd8e3; writing-mode: vertical-rl; text-orientation: upright;
      background: linear-gradient(180deg, rgba(24,30,42,.95), rgba(10,13,19,.97));
      border: 1px solid rgba(150,170,210,.34); border-radius: 9px;
      transition: color .16s, border-color .16s, background .16s; }
    body.ui-compact #input-strip:hover, body.ui-compact #input-strip:active {
      color: #ffe0a0; border-color: rgba(255,210,92,.72);
      background: linear-gradient(180deg, rgba(46,42,26,.96), rgba(18,15,9,.98)); }
    body.ui-compact.input-open #input-strip { color: #ffe0a0; border-color: rgba(255,210,92,.85);
      background: linear-gradient(180deg, rgba(52,46,25,.97), rgba(22,18,10,.98)); }
    /* 生成中提示（AI 思考中）：竖条转琥珀色 + 呼吸光晕 + 文字换成「生成中」——
       目的是提醒玩家：要中止就点它展开面板，里面有 ■ 中止键。
       状态源是 body.is-generating（_applyBusyLock 在切换思考态时打/摘）。 */
    body.ui-compact #input-strip .is-busy { display: none; }
    body.ui-compact.is-generating #input-strip { color: #ffd98c; border-color: rgba(255,210,92,.82);
      background: linear-gradient(180deg, rgba(52,42,20,.97), rgba(24,17,8,.98));
      animation: stripBusy 1.15s ease-in-out infinite; }
    body.ui-compact.is-generating #input-strip .is-idle { display: none; }
    body.ui-compact.is-generating #input-strip .is-busy { display: block; }
    @keyframes stripBusy {
      0%, 100% { box-shadow: 0 0 0 0 rgba(255,210,92,0); }
      50% { box-shadow: 0 0 14px 2px rgba(255,210,92,.42); }
    }
    /* ④ 输入面板：紧凑档与正文窗同尺寸（位置/尺寸由 JS 写入），内部留白再收一档；
         目标选择框的宽度由网格跨列决定（= 三个按钮之和），这里只管把右键内边距压窄 */
    body.ui-compact #input-popup #chat-input-area { padding: 25px 8px 8px; gap: 6px; }
    body.ui-compact #input-popup #chat-input { padding: 7px 10px; }
    body.ui-compact #input-popup #chat-send { padding: 0 12px; }
    body.ui-compact #input-popup #chat-reroll, body.ui-compact #input-popup #chat-stop { padding: 0 10px; }

    /* ⑤ 编队页大画布在矮屏上再收一档内边距（可拖曳范围不变） */
    body.ui-compact.in-prep #main-content { padding: 4px 6px calc(var(--vh) * 40 + 10px); }
  `;

  const Router = {
    init(win) {
      this.win = win;
      this.body = win.document.body;
      // 让位稳定化计时器：上一个窗口的 id 在新窗口里已无意义（计时器 id 按 window 计），
      // 开窗先归零，避免误清掉新窗口里同号的无关计时器。
      this._galT1 = 0;
      this._galT2 = 0;
      // 前端弹窗替代浏览器网页通知：alert → modal 提示；confirm → 异步确认(Promise)
      this._overrideDialogs();
      this.renderBaseUI();
      // 立绘同台层是宿主闭包内单例，跨窗口存活——每次开窗强制重置，由正文说话人流程重建舞台
      try { PortraitStage.reset(); } catch (e) {}
      ensureGameVars(this.win);   // 持久化全部 CORE_VARS 容器（含 敌方库/蚀刻章/行动），让 json_patch 增量写入能找到父级
      this.bindChatEvents();
      // 打开界面时先从变量恢复上次运行状态，避免每次从头开始
      const resume = this._restoreGameState();
      // 拉开局选择的面板默认值（难度数字按钮 / 分队选牌）跟随存档，未开始游戏前改动只暂存内存
      try {
        const v0 = readVars(this.win);
        State.pendingDifficulty = Math.max(0, Math.min(6, Math.trunc(Number((v0['$难度'] || {}).档位)) || 0));
        State.pendingSquad = (v0['$难度'] || {}).分队 || '后勤分队';
      } catch (e) { State.pendingDifficulty = 1; State.pendingSquad = '后勤分队'; }
      this.switchView(resume);
      // 蚀刻章：重开窗口时补齐一次（条件是变量驱动的，关着窗口期间达成的也不能漏发）
      setTimeout(() => { try { this._syncEtchBadges(); } catch (e) {} }, 600);
      // 重开窗口后：重读最后一条 AI 消息并重渲染 <action_options>（选项只在"收到 AI 回复"事件时渲染，重开会丢，需补一次）
      try {
        const latest = this.win.getChatMessages ? this.win.getChatMessages(-1) : null;
        const last = latest && latest.length ? latest[latest.length - 1] : null;
        if (last && (last.role === 'assistant' || last.role === 'ai')) this._parseActionOptions(last.message || '');
      } catch (e) {}
      // 监听 AI 新消息 → 重载历史 + 解析结构化选项
      setTimeout(() => {
        if (this.win.eventOn && this.win.tavern_events) {
          this.win.eventOn(this.win.tavern_events.MESSAGE_RECEIVED, (id, type) => {
            setTimeout(() => {
              // 兜底复位：能收到 AI 消息说明此次生成必然已经结束，
              // 无论 GENERATION_ENDED/STOPPED 是否漏触发，都强制解锁思考/中止按钮。
              State.pendingNoBusyUntil = Date.now() + BUSY_SUPPRESS_MS;
              this._setBusy(false);
              this.loadHistoryChat();
              // 记录本次 AI 回复长度；若 <20 字符（空回）则弹窗提示重roll（用前端 modal）
              try {
                const latest = this.win.getChatMessages ? this.win.getChatMessages(-1) : null;
                const last = latest && latest.length ? latest[latest.length - 1] : null;
                if (last && (last.role === 'assistant' || last.role === 'ai')) {
                  const stripped = this._stripHiddenTags(last.message || '').replace(/<(?:Option|eventp)[\s\S]*?>/gi, '').trim();
                  if (stripped.length < 20) {
                    this._uiAlert('空回啦 请重roll', '空回复').catch(() => {});
                  }
                }
              } catch (e) {}
              // 收到 AI 回复：解析正文 <action_options> 并渲染为选项按钮（完全通用，任意界面均可用）
              this._handleAiReply();
              // 剧情日志：先按年月日重排（AI 新插入的条目只会被 MVU 追加在末尾），
              // 再查一次"有没有新增/覆写的条目"。
              // MVU 可能晚于 MESSAGE_RECEIVED 才写完变量 → 主通道是 Mvu.events.VARIABLE_UPDATE_ENDED，
              // 这里只是**兜底通道**，两次延时各查一遍；变更有快照去重，两边都跑到也只会弹一次。
              try { this._sortChronicle(); } catch (e) {}
              [900, 1800].forEach((ms) => setTimeout(() => {
                try { this._sortChronicle(); } catch (e) {}
                try { this._checkChronicleUpdates(); } catch (e) {}
              }, ms));
            }, 120);
          });
          // 生成期锁定：AI 生成时禁用结构化/推演/发送
          // 关键修复「中止按钮在 AI 回复完成后又闪回思考中」：
          //   GENERATION_ENDED/STOPPED 或收到 AI 消息后，会写入一个"抑制窗口"；
          //   在此窗口内酒馆若又误发一次 GENERATION_STARTED（时序错乱/收尾），会被忽略，按钮保持已停止。
          const markStopped = () => { State.pendingNoBusyUntil = Date.now() + BUSY_SUPPRESS_MS; this._setBusy(false); };
          this.win.eventOn(this.win.tavern_events.GENERATION_STARTED, () => {
            // 白名单门控：只信"本端主动发起"的生成（armed，见 _commitPlayerMessage/_sendAsUser/handleReroll）。
            // ① 忽略窗口内（刚完成/中止/刚被忽略的怪癖）→ 直接忽略；
            // ② 未 armed 或超时作废 → 视为酒馆怪癖/时序重置：不置忙，并落一个冷却窗口；
            // ③ armed 认领 → 消费 armed、置忙。**非本端发起的 STARTED 永不点亮中止态**。
            if (Date.now() < State.pendingNoBusyUntil) return; // 刚完成/中止过 → 忽略这次误触发
            if (!State.armed || Date.now() - State.armedAt > ARMED_TIMEOUT_MS) {
              State.armed = false;
              State.pendingNoBusyUntil = Date.now() + BUSY_SUPPRESS_MS;
              return;
            }
            State.armed = false;
            this._setBusy(true);
          });
          this.win.eventOn(this.win.tavern_events.GENERATION_ENDED, () => markStopped());
          this.win.eventOn(this.win.tavern_events.GENERATION_STOPPED, () => markStopped());
          // ── 剧情日志变更广播：主通道（作者要求"等 AI 的变量更新完成再检查"）──────────────
          //   MVU 在**变量更新真正结束**时抛 VARIABLE_UPDATE_ENDED(new_variables, old_variables)，
          //   这是唯一能确切知道"AI 的更新指令跑完了"的时机；MESSAGE_RECEIVED 与它谁先谁后不可赌，
          //   所以上方的 MESSAGE_RECEIVED 里还留了两档延时兜底（有快照去重，不会重复弹）。
          //   ⚠ 不读事件给的变量对象本体（那是 MVU 的活对象），只借它当"时机信号"，
          //     真正的比对一律回 readVars 走正常读路径取叶子字符串。
          try {
            const mvuEvents = this.win.Mvu && this.win.Mvu.events;
            if (mvuEvents && mvuEvents.VARIABLE_UPDATE_ENDED) {
              this.win.eventOn(mvuEvents.VARIABLE_UPDATE_ENDED, () => {
                try { this._checkChronicleUpdates(); } catch (e) {}
              });
            } else {
              console.info('[集成战略] 未取到 Mvu.events.VARIABLE_UPDATE_ENDED，剧情日志播报改用回复后兜底检查。');
            }
          } catch (e) { console.warn('[集成战略] 剧情日志监听注册失败（不影响游戏）：', e && e.message); }
          // 基线快照：只记录不弹 —— 否则一进游戏就会把历史日志全部播一遍
          try { State.chronicleFp = this._chronicleNow(); } catch (e) {}
        }
      }, 0);
      // 生成卡死看门狗（宿主级单例）：思考态持续超过上限（正常生成到不了）→ 强制复位，
      // 配合「完成/中止窗口」，杜绝 busyPhase 卡在 generating → 重roll 被永久拒绝。
      if (!busyWatchdog) busyWatchdog = setInterval(() => {
        if (State.busyPhase === 'generating' && Date.now() - State.genAt > BUSY_WATCHDOG_MS) {
          console.warn('[集成战略] 生成状态疑似卡死（持续 >' + Math.round(BUSY_WATCHDOG_MS / 60000) + ' 分钟），强制复位');
          this._setBusy(false);
        }
      }, 30000);
    },

    /** 切换 AI 生成锁定状态：true=思考中禁用；false=已停止，强制解锁（哪怕中断也要解锁） */
    _setBusy(busy) {
      State.busyPhase = busy ? 'generating' : 'idle';
      State.genAt = busy ? Date.now() : 0;
      this._applyBusyLock();
    },

    /**
     * 让所有可交互按钮与当前 busyPhase 保持一致。
     * 关键：每次渲染（例如 renderCombatBoard 重建按钮）后都要调用它，
     * 确保"确认推演/发送/停止"按钮的禁用状态不会丢失或与思考状态脱节。
     * 只要 busyPhase 不是 generating（含被中断后复位），一律解锁（disabled=false）。
     */
    _applyBusyLock() {
      const root = this.win.document;
      const locked = State.busyPhase === 'generating';
      // 根节点 class 供结构化按钮判断
      this.body.classList.toggle('is-generating', locked);
      this.body.className = this.body.className
        .split(/\s+/).filter((c) => c && c !== 'is-generating').join(' ')
        + (locked ? ' is-generating' : '');
      // 关键：确认推演按钮【始终可点】（不设 disabled）。
      // 因为一旦按钮被 disabled，点击根本不会触发 onClick，也就无法在按钮内自救解锁。
      // 思考中防止重复推演交由 resolveTurn 的 busyPhase 守卫处理；卡死则由 onClick 超时兜底解锁。
      const send = root.getElementById('chat-send');
      if (send) send.disabled = locked;
      // 〖中止思考按钮〗：**只有两态** —— 思考中=「中止」(可点+转圈) / 空闲=「■」(暗·禁用)。
      // 初始 HTML 与每次 _setBusy 都会归一到这里，杜绝"停止/中止/暗"三态混用。
      const stopBtn = root.getElementById('chat-stop');
      if (stopBtn) {
        if (locked) {
          stopBtn.disabled = false;                     // 思考中可点中止
          stopBtn.classList.add('spinning');
          stopBtn.title = 'AI 思考中，点击中止回复';
          stopBtn.innerHTML = `<span class='spinner'></span> 中止`;
        } else {
          stopBtn.disabled = true;                      // 空闲 = 暗（禁用）
          stopBtn.classList.remove('spinning');
          stopBtn.title = 'AI 未在思考';
          stopBtn.textContent = '■';
        }
      }
      // 结构化选项按钮
      root.querySelectorAll('.option-chip').forEach((b) => { b.disabled = locked; });
    },

    // ====================================================================
    // 前端弹窗系统（替代浏览器 alert/confirm 网页通知）
    //   _uiAlert(msg, title?)   信息弹窗：一个「确认/关闭」按钮。
    //   _uiConfirm(msg, title?) 确认弹窗：返回 Promise<boolean>（确认/取消）。
    // ====================================================================
    /** 覆盖 win.alert / win.confirm，让所有浏览器网页通知改走前端弹窗。 */
    _overrideDialogs() {
      const self = this;
      try {
        if (this.win && typeof this.win === 'object') {
          // alert → 前端信息 modal（所有 this.win.alert(...) 调用自动改走前端弹窗）
          this.win.alert = (msg) => { self._uiAlert(msg); };
          // confirm → 保持原生语义由调用点改走 _uiConfirm().then；此处兜底为可用 Promise
          if (typeof this.win.confirm !== 'function' || this.win.confirm.toString().indexOf('[native code]') !== -1) {
            // 不做主动覆盖，由调用点显式走 _uiConfirm
          }
        }
      } catch (e) {}
    },

    /** 信息弹窗：前端 modal，带「确认/关闭」按钮。 */
    _uiAlert(msg, title = '提示') {
      return this._uiModal({ title, body: String(msg), okText: '知道了' })
        .then(() => undefined);
    },

    /** 确认弹窗：返回 Promise<boolean>。 */
    _uiConfirm(msg, title = '确认') {
      return this._uiModal({ title, body: String(msg), okText: '确认', cancelText: '取消' });
    },

    /**
     * 多选一弹窗：resolve 成被点按钮的 key；点遮罩 = ''（等同取消）。
     * @param {{title?:string, body?:string, buttons:{key:string,text:string,cls?:string}[]}} opts
     *   buttons 里的 cls：'gold' | 'gray' | 'red'（缺省按 gray 处理）。
     */
    _uiChoose(opts) {
      const o = opts || {};
      const win = this.win;
      const doc = win.document;
      const old = doc.getElementById('modal-overlay');
      if (old) old.remove();
      return new Promise((resolve) => {
        const overlay = doc.createElement('div');
        overlay.id = 'modal-overlay';
        overlay.className = 'modal-overlay';
        const box = doc.createElement('div');
        box.className = 'modal-box';
        box.innerHTML = '<div class="modal-title"></div><div class="modal-body"></div><div class="modal-btns"></div>';
        box.querySelector('.modal-title').textContent = o.title || '';
        box.querySelector('.modal-body').textContent = o.body || '';
        const wrap = box.querySelector('.modal-btns');
        const close = (result) => { overlay.remove(); resolve(result); };
        (Array.isArray(o.buttons) ? o.buttons : []).forEach((b) => {
          const btn = doc.createElement('button');
          btn.className = 'modal-btn ' + (b.cls || 'gray');
          btn.textContent = b.text || b.key || '';
          btn.onclick = () => close(b.key || '');
          wrap.appendChild(btn);
        });
        overlay.onclick = (e) => { if (e.target === overlay) close(''); };
        overlay.appendChild(box);
        doc.body.appendChild(overlay);
      });
    },

    /**
     * 文本输入弹窗：resolve 成输入内容；点取消 / 点遮罩 / Esc → null（= 用户放弃，调用方不要写变量）。
     * @param {{title?:string, body?:string, value?:string, placeholder?:string}} opts
     */
    _uiPrompt(opts) {
      const o = opts || {};
      const win = this.win;
      const doc = win.document;
      const old = doc.getElementById('modal-overlay');
      if (old) old.remove();
      return new Promise((resolve) => {
        const overlay = doc.createElement('div');
        overlay.id = 'modal-overlay';
        overlay.className = 'modal-overlay';
        const box = doc.createElement('div');
        box.className = 'modal-box';
        box.innerHTML = '<div class="modal-title"></div><div class="modal-body"></div>'
          + '<input class="modal-input" type="text" maxlength="24" name="jczl-ui-text-noautofill"'
          + ' autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"'
          + ' data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other">'
          + '<div class="modal-btns"><button class="modal-btn cancel" data-role="cancel">取消</button>'
          + '<button class="modal-btn ok" data-role="ok">确定</button></div>';
        box.querySelector('.modal-title').textContent = o.title || '输入';
        box.querySelector('.modal-body').textContent = o.body || '';
        const inp = box.querySelector('.modal-input');
        inp.value = (o.value == null) ? '' : String(o.value);
        inp.placeholder = o.placeholder || '';
        const close = (result) => { overlay.remove(); resolve(result); };
        box.querySelector('[data-role="ok"]').onclick = () => close(inp.value);
        box.querySelector('[data-role="cancel"]').onclick = () => close(null);
        inp.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); close(inp.value); }
          else if (e.key === 'Escape') { e.preventDefault(); close(null); }
        };
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
        overlay.appendChild(box);
        doc.body.appendChild(overlay);
        setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
      });
    },

    /** 通用 modal。返回 Promise：有 cancelText 则 resolve(ok?true:false)；否则 resolve(true)。 */
    _uiModal(opts) {
      const win = this.win;
      const doc = win.document;
      // 移除已有 modal（防叠加）
      const old = doc.getElementById('modal-overlay');
      if (old) old.remove();
      return new Promise((resolve) => {
        const overlay = doc.createElement('div');
        overlay.id = 'modal-overlay';
        overlay.className = 'modal-overlay';
        const box = doc.createElement('div');
        box.className = 'modal-box';
        box.innerHTML = `
          <div class="modal-title">${opts.title || ''}</div>
          <div class="modal-body"></div>
          <div class="modal-btns">
            ${opts.cancelText ? `<button class="modal-btn cancel" data-role="cancel">${opts.cancelText}</button>` : ''}
            <button class="modal-btn ok" data-role="ok">${opts.okText || '确认'}</button>
          </div>`;
        box.querySelector('.modal-body').textContent = opts.body || '';
        const okBtn = box.querySelector('[data-role="ok"]');
        const cancelBtn = box.querySelector('[data-role="cancel"]');
        const close = (result) => {
          overlay.remove();
          resolve(result);
        };
        okBtn.onclick = () => close(true);
        if (cancelBtn) cancelBtn.onclick = () => close(false);
        // 点击遮罩关闭
        overlay.onclick = (e) => { if (e.target === overlay) close(false); };
        overlay.appendChild(box);
        doc.body.appendChild(overlay);
        okBtn.focus && okBtn.focus();
      });
    },

    renderBaseUI() {
      this.body.innerHTML = `
        <div id="root">
          <div id="top-bar">
            <div class="stat-item" title="核心生命"><span class="ic-trap"></span><span id="dev-hp">10</span></div>
            <div class="stat-item" title="淫堕源石"><span class="ic-ellipse"></span><span id="dev-stone">0</span></div>
            <div class="stat-item" title="精液"><span class="ic-tri"></span><span id="dev-money">0</span></div>
            <div class="top-bar-center">
              <button class="top-drop" id="drop-collect" title="查看本局收藏品">收藏品库</button>
              <button class="top-drop" id="drop-roster" title="查看干员编队">干员编队</button>
              <button class="top-drop" id="drop-base" title="选择主战干员">主战干员</button>
              <button class="top-drop" id="drop-timeline" title="查看本局历史时间轴">时间轴</button>
            </div>
            <div style="margin-left:auto;display:flex;gap:8px;">
              <button class="top-btn" id="fullscreen-btn" title="浏览器全屏">全屏</button>
              <button class="top-btn" id="emergency-btn" title="放弃本局并重置进度">紧急熔断</button>
              <button class="top-btn" id="close-btn" title="退出游戏界面">退出游戏</button>
            </div>
          </div>

          <!-- 层数：顶边栏下方左侧的大号罗马数字（非 1~5 显示 X） -->
          <div id="layer-roman" class="layer-roman">Ⅰ</div>

          <!-- 中部舞台：背景/CG + 主视图 -->
          <div id="stage">
            <div id="main-content"></div>
          </div>

          <!-- 底部聊天面板：现在只承担「输入条 + 可展开的对话记录」；
               正文（打字机/逐段推进/名牌/头像）全部在下方独立的 Galgame 窗口里。 -->
          <div id="chat-container">
            <!-- 收起态：这层不显示任何正文；展开态：完整对话记录 -->
            <div id="chat-history"></div>
            <div id="options-container"></div>
            <!-- 「输出中 / 还有下一组」的黄色箭头 -->
            <div id="gal-arrow">▼</div>
            <div id="chat-input-area">
              <select id="target-selector" title="发送对象" name="jczl-target-noautofill" autocomplete="off"><option value="">(无指定对象)</option></select>
              <!-- ⚠ 输入框必须"看起来不像任何表单字段"，否则浏览器会弹账密/自动填充联想栏（很碍事）。
                   做法 = 改 name（不用 user/email/msg 之类语义词）+ 一堆关自动特性的属性；
                   id 保持不变（大量 getElementById('chat-input') 依赖它），只动 name/属性。 -->
              <input id="chat-input" type="text" name="jczl-dialogue-line" placeholder="输入对话…"
                     autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                     enterkeyhint="send" inputmode="text" role="textbox" aria-autocomplete="none"
                     data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other">
              <button id="chat-send">发送</button>
              <button id="chat-reroll" title="重新生成最后一条 AI 回复">↻</button>
              <button id="chat-stop" title="AI 未在思考（思考中可点击中止）" disabled>■</button>
            </div>
          </div>

          <!-- ===== 独立 Galgame 窗口（与原聊天框彻底分离）=====
               正文在这里整页翻动；原聊天框只保留输入条与可展开的对话记录。
               右上角框外悬浮 = 玩家最后一条发言。
               点击翻页的热区就是 #gal-box 本身（与所见对话框严格重合）。
               ⚠ 必须是 #root 的直接子级、绝不能放进 #chat-container：
                 #chat-container 是 display:flex 的列容器，子元素会被当 flex item 布局，窗口会被压扁。 -->
          <div id="gal-layer">
            <div id="gal-box" title="单击：翻下一页">
              <!-- 玩家最后一条发言气泡：贴在对话框上边缘（见 #gal-float 的 bottom:100%）-->
              <div id="gal-float">
                <div id="gal-you" class="gal-you off"></div>
              </div>
              <div id="gal-name" class="off"></div>
              <img id="gal-avatar" alt="">
              <div id="gal-body"></div>
              <!-- 翻页箭头：左下回上一页 / 右下下一页；页角标居中 -->
              <div id="gal-back" title="上一页">◀</div>
              <div id="gal-pager"></div>
              <div id="gal-next" title="下一页">▼</div>
            </div>
          </div>

          <!-- 立绘同台层：介于背景与聊天框之间；底部略微嵌入聊天框（见 --ps-overlap）。
               ps-a=首名登台角色（单人居中/双人靠左），ps-b=次名（双人靠右）；
               槽位固定，换人只切明暗（lit/dim 类），绝不重排左右。 -->
          <div id="portrait-stage">
            <div class="ps-slot" id="ps-a"><img alt=""></div>
            <div class="ps-slot" id="ps-b"><img alt=""></div>
          </div>

          <!-- 展开/收起对话记录按钮：
               必须留在 #root 直接子级（**不能**放在 #chat-container 里），
               否则它被困在 #chat-container 的层叠上下文(50)里，被 gal 层(200)盖住点不到。 -->
          <button id="chat-expand" title="展开/收起对话记录">▴</button>

          <!-- 窄屏专用（紧凑档）：展开输入竖条 + 完整输入面板。
               面板的位置与尺寸由 _layoutInputPopup 实测正文窗(#gal-layer)矩形后写进 inline，
               真正的输入行 #chat-input-area 在打开时整块搬进来（事件绑定原样保留）。
               ⚠ 桌面档这两块恒为 display:none，输入行仍留在 #chat-container 里 —— 桌面排版不变。 -->
          <button id="input-strip" type="button" title="展开输入框（AI 思考中可在此点 ■ 中止）"><span class="is-idle">展开输入</span><span class="is-busy">生成中</span></button>
          <div id="input-popup">
            <button id="input-popup-close" type="button" title="收起输入框">✕ 收起</button>
          </div>
        </div>`;
      // Galgame 状态：进度**不持久化**（关窗即忘）；_galSeen 只用来避免"整段重刷时重播旧消息"
      this._galSeen = {};           // 已加载过的消息 id（防重刷重置页数）
      this._galSyncedId = null;     // 窗口当前对齐到的消息 id
      this._galMsgId = null;        // 当前已加载正文的消息 id
      this._galGroups = [];         // 本条正文的全部页（切分即加载完，翻页只读内存）
      this._galIndex = -1;          // 当前页号（0 起；-1 = 还没加载）
      this._galSpeaker = '';        // 当前说话人（本页没带 <名字> 时沿用）
      this._galDbgOnce = false;      // sync 未加载日志只打一次
      this.bindBaseEvents();
      this.loadChatTargets();
      this.loadHistoryChat();
      // 直连兜底：打开界面后补一次"从接口现场取最新 AI 正文"（不依赖清洗缓存时序）。
      // 平时静默；只有真取不到正文时才由 _galLoadLatest 打一行提示。
      setTimeout(() => { try { this._galLoadLatest(); } catch (e) {} }, 400);
    },

    bindBaseEvents() {
      this.win.document.getElementById('close-btn').onclick = () => this.win.closeGame();
      // 自检热键：Shift+G → 打印 Galgame 窗口运行状态（排查"正文出完了但窗口空白"）
      //          Shift+M → 循环界面密度 自动→桌面→紧凑（手机端排版排查用，见 compactStyles）
      this.win.document.addEventListener('keydown', (e) => {
        if (e.shiftKey && (e.key === 'G' || e.key === 'g')) { try { this._galDebug(); } catch (err) {} }
        if (e.shiftKey && (e.key === 'M' || e.key === 'm')) { try { this._cycleUiDensity(); } catch (err) {} }
      });
      this.win.document.getElementById('emergency-btn').onclick = () => {
        if (State.busyPhase === 'generating') return;      // 思考中禁止熔断（会重置本局进度）
        this._uiConfirm('确定要放弃本次探索并重置进度吗？（仅清空本局内容，保留标本室等长线收藏）', '紧急熔断').then((ok) => {
          if (ok) {
            this._resetRun();
            // 紧急熔断后触发一个极简回复，让 AI 收尾这段探索（回到主城起点）
            Engine._sendAsUser(this.win, this._sys('你发动紧急熔断，本次探索就此终止，一切归于起点。'));
          }
        });
      };
      // 二级全屏切换
      const fsBtn = this.win.document.getElementById('fullscreen-btn');
      if (fsBtn) {
        fsBtn.onclick = () => this.toggleFullscreen();
      }
      // 聊天展开/收起
      const expBtn = this.win.document.getElementById('chat-expand');
      if (expBtn) expBtn.onclick = () => this.toggleChatExpand();
      // 窄屏（紧凑档）输入条：竖条开关 / 面板右上角收起（桌面档这两个节点都不显示，绑定本身无害）
      const stripBtn = this.win.document.getElementById('input-strip');
      if (stripBtn) stripBtn.onclick = () => this.toggleInputPopup();
      const ipClose = this.win.document.getElementById('input-popup-close');
      if (ipClose) ipClose.onclick = () => this._closeInputPopup();
      // 显式中断回复按钮：无论当前是否在思考，点击即中断并强制解锁所有按钮
      const stopBtn = this.win.document.getElementById('chat-stop');
      if (stopBtn) stopBtn.onclick = () => this.abortGeneration();
      // 发送对象下拉：切换显示对象 → 节点内联动切换角色背景图（聊天/输入框不动）
      const tsel = this.win.document.getElementById('target-selector');
      if (tsel) tsel.addEventListener('change', () => { if (State.currentStatus === 'event_node') this._setNodeStageBg(tsel.value); });
      // 顶栏下拉：收藏品库 / 干员编队（A1–A4 重建面板）
      const dc = this.win.document.getElementById('drop-collect');
      if (dc) dc.onclick = () => this.openCollect();
      const dr = this.win.document.getElementById('drop-roster');
      if (dr) dr.onclick = () => this.openRoster('list');
      const db = this.win.document.getElementById('drop-base');
      if (db) db.onclick = () => {
        if (this._replayOn()) { this._uiAlert('重玩模式下不能换主战干员：这里没有正常探索流程。', '重玩模式'); return; }
        this._openBasePicker();
      };
      // 时间轴：整页浏览本局「剧情日志」，按泰拉历升序（与 _sortChronicle 同口径）
      const dtl = this.win.document.getElementById('drop-timeline');
      if (dtl) dtl.onclick = () => this._renderChroniclePage();
      // 重玩模式：熔断/主战干员 锁死
      this._syncReplayLocks();
    },

    /** 顶栏下拉切换：collect=收藏品库，roster=局内干员库。点同按钮收起，点另一则替换。 */


    /** 绑定下拉面板内的交互（晋升按钮等）。面板刷新后亦需调用。 */




    /** 收藏品库下拉内容：名称 + 描述（含底层标签） */


    /** 干员库下拉内容：每干员一张卡（头像/数值/推动格/特殊效果/晋升按钮/档案），可翻页滚动 */


    /** 干员卡数值 + 数据（晋升/增益叠加），供干员库面板与棋盘检视共用 */


    /** 干员基础伤害（不含晋升/+桶） */

    /** 推动格图标文本：标注每格推动格距离（近→远）与推动距离（触发后位移几格）。 */

    /** 生成推动格 5×5 格子图：中心为本体格(★)，各推动格标蓝。用 pushCells 计算相对坐标。 */

    /** 内置档案或通用兜底文本 */


    /** 关闭右侧检视弹窗（若已开启）并可清除文档级点击监听 */


    /**
     * 棋盘内/备战区/编队界面单击干员 → 右侧悬浮检视面板。
     * 显示增益后最终数值 + 主动技能/特殊效果启用按钮（暂无功能，占位）。
     * 只要用户点击弹窗以外的任意位置即关闭（含点其它干员开新面板）。
     */


    /** 晋升：仅对「侵蚀」阶段使用，耗 4 源石/人（难度4 起 5）；晋升后状态改为「活化」并记入已晋升，不可再晋升。
     *  扣费只在前端进行（_doPromoteConfirm）；战报会向 AI 明示"已扣费完成"，AI 不得再改 淫堕源石。 */


    /**
     * 显式中断 AI 回复：
     *  1) 调用酒馆的中止生成；
     *  2) 无论是否真的收到 GENERATION_STOPPED，都强制把 busyPhase 复位并解锁全部按钮，
     *     避免"思考中被锁死又没人解锁"导致推演按钮点不动。
     */
    abortGeneration() {
      if (this.win.triggerSlash) {
        try { this.win.triggerSlash('/stop').catch(() => {}); } catch (e) {}
      }
      // stop 收尾过程中酒馆还可能再补一发 GENERATION_STARTED（时序怪癖），
      // 在此窗口内一律忽略，防止「中止」按钮/忙碌态被无谓重新点亮。
      State.pendingNoBusyUntil = Date.now() + ABORT_SUPPRESS_MS;
      this._setBusy(false); // 强制解锁：只要不再思考，按钮可用
      // 对生成中的系统做兜底：再补一发，确保事件监听也收到停止
      setTimeout(() => this._setBusy(false), 60);
    },

    /** 聊天面板展开/收起：普通界面向上展开；棋盘/地图类界面向右（横向）展开。
     *  展开态＝「对话记录」：整段全显示（停打字、藏箭头与头像框），与 Galgame 窗口是两个视图。
     *  收起态＝回到独立 Galgame 窗口（正文继续一段段播）。 */
    toggleChatExpand() {
      const cc = this.win.document.getElementById('chat-container');
      const exp = this.win.document.getElementById('chat-expand');
      if (!cc) return;
      const expanded = cc.classList.toggle('expanded');
      const isLeft = this.body.classList.contains('in-chat-left');
      if (exp) exp.innerText = expanded ? (isLeft ? '◂' : '▾') : (isLeft ? '▸' : '▴');
      // 紧凑档：按钮要跟着展开态换边（贴住"当前可见底栏"的上沿）
      this._expandBtnLayout();
      if (expanded) {
        // 让位给「对话记录」：Galgame 窗口整层收起
        this._galShow(false);
        const ar = this.win.document.getElementById('gal-arrow');
        if (ar) ar.classList.remove('on');
        cc.classList.remove('gal-ava');
        // 重渲染一次：让消息级功能按钮（🔄🗑️）出现在"对话记录"里
        this._renderChatWindow();
      } else {
        // 收起 → 回到 Galgame 窗口
        cc.classList.remove('gal-ava');
        this._renderChatWindow();
        this._galShow(this._galVisible() && !!(this._galGroups || []).length);
      }
      // 战斗/地图界面展开会让内容区被盖一部分，展开后回读棋盘
      if (State.currentStatus === 'combat_board') return;
    },

    /** 二级全屏：真实浏览器全屏 / 退出 */
    toggleFullscreen() {
      const doc = this.win.document;
      const el = doc.documentElement;
      try {
        if (!this.win.document.fullscreenElement && !this.body.classList.contains('fullscreen')) {
          // 优先 requestFullscreen；失败则退化为根容器全屏（设置 body 覆盖）
          if (el.requestFullscreen) { el.requestFullscreen().catch(() => this._fallbackFullscreen(true)); }
          else this._fallbackFullscreen(true);
        } else {
          if (this.win.document.exitFullscreen) this.win.document.exitFullscreen();
          else this._fallbackFullscreen(false);
          this._fallbackFullscreen(false);
        }
      } catch (e) { this._fallbackFullscreen(!this.body.classList.contains('fullscreen')); }
    },

    _fallbackFullscreen(inFull) {
      if (inFull) this.body.classList.add('fullscreen');
      else this.body.classList.remove('fullscreen');
    },

    /** 切换到某状态时设定背景 */
    updateBackground() {
      const bg = BgMap[State.currentStatus];
      if (bg) {
        this.body.style.backgroundImage = `url("${bg}")`;
        this.body.style.backgroundSize = 'cover';
        this.body.style.backgroundPosition = 'center';
        this.body.style.backgroundAttachment = 'fixed';
        // 直接背景图：不加深色遮罩（可读性交由各界面自身的减暗层/气泡色块保证）
        const overlay = this.win.document.getElementById('bg-overlay');
        if (overlay) overlay.remove();
      }
    },

    /**
     * 经济复位为初始值（**唯一权威口径**）——通关 / 失败 / 熔断 / 存档退出 / 开新局 五条路径共用：
     *   玩家资源 回初始值、难度/分队暂时归位默认、晋升报价归位默认。
     *   之后回到开局界面重选编队，再「确认并出发」叠加一份难度/分队修正 →【重置 → 叠加】循环。
     * ⚠ 写钱只有三处（前端侧）：本函数（复位）、_applyRunDifficulty（出发时加一份修正）、
     *   _doPromoteConfirm（晋升扣费）。除此之外前端绝不动 玩家资源。
     *   旧版的 $开局基线 / $开局修正 账本已删除：出发前必然先走本函数复位，
     *   所以"基线 + 一份修正"等价于"初始值 + 一份修正"；那套回退分支永远走不到（且读写在两个不同的键上）。
     * @param {object} d writeVars 的楼层变量草稿（就地改写）
     */
    _resetEconomyDraft(d) {
      d['玩家资源'] = { 核心生命: 10, 淫堕源石: 0, 精液: 0, 所知: 0, 已晋升干员: [] };
      d['$难度'] = { 档位: 1, 分队: '后勤分队' };
      d['$衰减档'] = diffCtx(1).decay;   // 归位默认口径（难度2 起为 0.75，由开局时重写）
      const prog = d['_探索进程'] = (d['_探索进程'] && typeof d['_探索进程'] === 'object') ? d['_探索进程'] : {};
      prog._晋升花费 = promoteSentence(diffCtx(1).promoteCost);   // 价目归位默认口径（由「确认并出发」按实际难度重写）
      // 顺手清掉旧版"开局账本"的嵌套残留（老存档里可能有）：三件套已废弃，别再留在变量里误导人。
      // （只清 _探索进程 内的；顶层 `$开局基线` 因为不在 CORE_VARS、writeVars 无法删除，
      //   留着既不被读取也无副作用，想彻底干净可在变量编辑器里手工删一次。）
      delete prog.$开局基线;
      delete prog.$开局修正;
      delete prog.$开局已应用;
    },

    /**
     * 本局范围的变量整体复位（唯一权威口径）——通关 / 失败 / 熔断 三条结束路径共用，
     * 并且**每次「确认并出发」开新局前也会防御性调用**：杜绝任何"上一局的残留状态"
     * （干员编队 / 地图 / 节点切片 / 收藏品 / 行动通道 / 长期池 / 基底干员）泄漏进第二把。
     * 顺序要求：开新局时先复位再写入新的基底干员（见 prep-start）。
     * 长线数据（标本库 / 蚀刻章 / 时间线记忆库 / _全局资产）一律保留；
     * **剧情日志属于"本局流水" → 在这里清空**（通关路径会先把它整段搬进 时间线记忆库 再调用本函数，
     *  见 _archiveChronicleInto；熔断/失败没有归档，本局流水随之丢弃）。
     */
    _resetRunScopedDraft(d) {
      this._resetEconomyDraft(d);
      d['干员编队'] = {};
      d['剧情日志'] = {};
      d['收藏品'] = {};
      d['_长期总池'] = { 污染: { 未来: 0, 过往: 0, 现实: 0 }, 去量化: 0 };
      d['$收藏品获得层'] = {};
      d['$隐藏关'] = { 海嗣: false, 月光: false, 特殊源石: false };   // 熔断/失败/通关/开新局全都过这里 → 一处复位覆盖四处
      d['行动'] = { 额外探索: false, 原定目标: '' };
      d['$切片'] = { $active: false, $status: 'out_of_game', $nodeData: null, $当前时间点: 1094, $当前敌方: '', $软硬: '硬', $原定角色: '', $收服基线: [], $额外收服完成: false, $变奏用尽: false, $锁定: false, $待定: false, $终局分支: '', $隐藏关: '' };
      d['$地图状态'] = { 层数: 1, 每列: [], 解锁列数: 1, 当前列: 0 };
      const prog = d['_探索进程'] = (d['_探索进程'] && typeof d['_探索进程'] === 'object') ? d['_探索进程'] : {};
      prog.$当前状态 = 'out_of_game';
      prog.$当前层数 = 1;
      prog.$当前位置 = '未出发';
      prog.$基底干员 = '';   // 上一局的基底作废（开新局时由 prep-start 重新写入）
      prog.$隐藏层 = false;  // 隐藏层是"每局重新解锁"的：下一局必须重新集齐蚀刻章+收藏品
    },

    /** 内存侧的开局选择复位（与新局口径一致） */
    _resetPrepSelection() {
      State.prepStep = 'squad';
      State.pendingDifficulty = 1;
      State.pendingSquad = '后勤分队';
      State.pendingShortRun = null;   // 回落到"跟随变量 $短对局"（上次出门的选择）
      State.gameOpened = false;
    },

    refreshStats() {
      const v = readVars(this.win);
      const g = (id) => this.win.document.getElementById('dev-' + id);
      if (g('hp')) g('hp').innerText = String(v.玩家资源?.核心生命 ?? 10);
      if (g('stone')) g('stone').innerText = String(v.玩家资源?.淫堕源石 ?? 0);
      if (g('money')) g('money').innerText = String(v.玩家资源?.精液 ?? 0);
      // 层数 → 顶边栏下方左侧的大号罗马数字；非 1~5 显示 X
      const lr = this.win.document.getElementById('layer-roman');
      if (lr) {
        const L = Number((v._探索进程 && v._探索进程.$当前层数) || 0);
        lr.textContent = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ'][L] || 'X';
      }
      // 常驻三轴雷达（右下角）：进出节点都刷新；节点内含时效收藏品，节点外不含
      this._ensureRadarPanel();
    },

    /** 本层遭遇池。第六层（隐藏层）没有独立 PoolDB 项 → 回落到第 5 层池，
     *  这样隐藏层的中间级（紧急作战/诡意行商/不期而遇）不会变成"没有目标角色"的空节点；
     *  日后若要给第六层独立编队，直接在 PoolDB 加一个 `6: {...}` 即可被自动采用（无需改这里）。 */
    _poolForLayer(layer) {
      const L = Number(layer) || 1;
      // 短对局：按合并表取（1→原1+2 / 3→原2+3 / 5→原4+5）；隐藏层与未命中表 → 走原口径。
      const merged = this._shortPoolFor(L);
      if (merged) return merged;
      return PoolDB[L] || PoolDB[5] || {};
    },

    /** 层名（面向玩家/AI 的所有文案都走这里，避免裸拼层号出现"第 100 层"之类） */
    _layerName(layer) {
      const L = Number(layer) || 1;
      return L >= HIDDEN_LAYER ? ('第 ' + L + ' 层（隐藏层）') : ('第 ' + L + ' 层');
    },

    // ===== 短对局（层序口径的唯一读者）=====================================================
    //   ⚠ 这 5 个方法是"层序"的唯一入口。除它们与 _recomputeLongPool/换层/敌池之外，
    //     全工程一律只看**层号本身**（layer === 3/5、>= HIDDEN_LAYER …），因此不需要任何改动。

    /** 本局是否开着「短对局」（读纯前端变量 $短对局） */
    _shortRunOn() {
      try { return readVars(this.win)['$短对局'] === true; } catch (e) { return false; }
    },

    /** 本局层序（含隐藏层）：正常 [1,2,3,4,5,6]，短对局 [1,3,5,6]。
     *  只喂给"按层号顺序重放"的口径（逐层衰减 / 过层数惩罚），不参与换层判定。 */
    _layerSeq() {
      return (this._shortRunOn() ? SHORT_LAYERS : FULL_LAYERS).concat([HIDDEN_LAYER]);
    },

    /** 下一层：正常 x→x+1；短对局 1→3、3→5、5→6（隐藏层入口由 _resolveClear 提前拦截，正常走不到 5→6）。
     *  当前层号不在层序里（中途改开关/手改变量等异常）→ 就近向上对齐，绝不让进度卡死。 */
    _nextLayer(layer) {
      const L = Number(layer) || 1;
      if (!this._shortRunOn()) return L + 1;
      const i = SHORT_LAYERS.indexOf(L);
      if (i < 0) return SHORT_LAYERS.find((x) => x > L) || HIDDEN_LAYER;
      return SHORT_LAYERS[i + 1] || HIDDEN_LAYER;
    },

    /** 短对局合并池：命中合并表才返回（非短对局 / 隐藏层 / 不在表内 → null，调用方回退原口径） */
    _shortPoolFor(layer) {
      try {
        if (!this._shortRunOn()) return null;
        return shortPoolDB()[Number(layer)] || null;
      } catch (e) { return null; }
    },

    /** 短对局补偿：第 5 层「boss 之前那一列」的下标 —— 该列固定为**单独一个**诡意行商，其它情况返回 -1。
     *  动机：第 4 层末级的行商随层被跳过，不补的话整局只剩第 1 层末级那一个交易节点。 */
    _shortBossShopCol(layer, totalCols) {
      const L = Number(layer) || 1;
      if (!this._shortRunOn() || L !== 5) return -1;
      const total = Number(totalCols) || this._layerCols(L);
      const col = total - 2;              // 末级（下标 total-1）是 boss，它前一列就是固定行商
      return col >= 1 ? col : -1;         // 至少留一列随机在前，别让第 5 层一进门就是行商
    },

    /** 本层 险路恶敌 的固定 boss 候选名单（未命中规则返回 []）。仅 3/5 层有效。
     *  规则表里可以写单个名字或名字数组；这里统一**归一成数组**返回（单名 → [名]），
     *  由 _pickDanger 负责过滤 + 随机，调用方不必再区分两种写法。 */
    _fixedBossFor(layer) {
      const L = Number(layer) || 0;
      if (L !== 3 && L !== 5) return [];
      const cds = (readVars(this.win)['收藏品']) || {};
      for (const rule of FIXED_BOSS_RULES) {
        if (!hasNamed(cds, rule.收藏品)) continue;
        const slot = rule[L];
        if (!slot) return [];
        const list = (Array.isArray(slot) ? slot : [slot]).filter(Boolean);
        return list.length ? list : [];
      }
      return [];
    },

    /**
     * 险路恶敌出谁（唯一入口）：
     *   1) 第六层（隐藏层）→ 固定 HIDDEN_BOSS（希尔达）；
     *   2) 第 3/5 层且命中固定 boss 规则 → 从该规则的候选名单里随机一位（单名 = 名单只有一个人）；
     *   3) 其余 → 该层原随机 boss 池（无 boss 池时退回该层作战池）。
     * 预设数值一律取 POOL_BY_NAME（已合并各层 + hiddenBoss），故固定 boss 不必先进某个池。
     * ⚠ 固定 boss 不吃开关筛网、也不做编队去重（作者拍板）：命中规则就是铁定出这几位。
     *   名单里的名字若在 POOL_BY_NAME 里查不到（名字写错），逐个剔除；全查不到才退回随机池。
     */
    _pickDanger(layer) {
      const L = Number(layer) || 1;
      const pickOne = (l) => (l && l.length) ? l[Math.floor(Math.random() * l.length)] : null;
      if (L >= HIDDEN_LAYER) return POOL_BY_NAME[HIDDEN_BOSS] || pickOne(PoolDB.hiddenBoss);
      // 固定 boss：候选按名查预设，剔除配错的名字后随机；名单非空即命中规则（与单名/数组写法无关）
      const fixed = this._fixedBossFor(L);
      if (fixed.length) {
        const presets = fixed.map((n) => POOL_BY_NAME[n]).filter(Boolean);
        if (presets.length) {
          if (presets.length < fixed.length) {
            console.warn('[集成战略] 固定boss候选里有名字查不到预设，已剔除：'
              + fixed.filter((n) => !POOL_BY_NAME[n]).join('、'));
          }
          return pickOne(presets);
        }
      }
      const pl = this._shortPoolFor(L) || PoolDB[L] || {};
      const raw = (pl.boss && pl.boss.length) ? pl.boss : pl.作战;
      // 开关筛网：先滤掉开关表禁用的名字（boss 池下限 2 已由拒绝逻辑保底）；滤空才回退原池防死局
      let cands = raw.filter((e) => isNameEnabled(e && e.name));
      // 编队精确去重（与进节点遭遇同口径）：随机 boss 不出本局已收服的干员；
      // 全被携带时才容忍重复（防第三层 boss 无候选）。
      try {
        const carried = new Set(Object.keys((readVars(this.win)['干员编队']) || {}));
        const fresh = cands.filter((e) => !carried.has(e.name));
        if (fresh.length) cands = fresh;
      } catch (e) {}
      return pickOne(cands.length ? cands : raw);
    },

    /** 隐藏层闸门：蚀刻章「灭世圣女-救世魔王」（必要） ∧ 收藏品「我要吃饭」（补齐）。缺一即普通循环。 */
    _hiddenGateMet() {
      const v = readVars(this.win);
      return hasNamed(v['蚀刻章'], HIDDEN_GATE.蚀刻章) && hasNamed(v['收藏品'], HIDDEN_GATE.收藏品);
    },

    /**
     * 离开当前节点后的去向 —— **全工程唯一终局判定口径（三态）**。
     *   advance     : 普通节点 / 第3层 boss → 照常换层
     *   enterHidden : 第5层 boss 且隐藏层闸门成立 → **不结算**，进第六层
     *   finish      : 最终结算（第5层 boss 未开门 / 第六层 boss 通关）
     *
     * 第5层 boss 的分支在**进节点时**就已冻结进 $切片.$终局分支（见 _enterNode），
     * 这里优先读冻结值：这样战斗中 AI 改写收藏品/蚀刻章也不会把结局改判；
     * 冻结值缺失（旧档/异常）才现算兜底。
     */
    _resolveClear() {
      const nd = State.currentNodeData;
      if (!nd || nd.type !== '险路恶敌') return { kind: 'advance' };
      const layer = Number(State.currentLayer) || 1;
      if (layer >= HIDDEN_LAYER) return { kind: 'finish', layer };   // 第六层 boss → 真结算
      if (layer !== 5) return { kind: 'advance', layer };            // 第3层 boss → 只换层
      const frozen = String(((readVars(this.win)['$切片'] || {}).$终局分支) || '');
      const branch = frozen || (this._hiddenGateMet() ? 'hidden' : 'finish');
      return branch === 'hidden' ? { kind: 'enterHidden', layer } : { kind: 'finish', layer };
    },

    /**
     * 通关归档：把 局内干员编队 中「活化阶段」的干员结算进永久 标本库（长线池），并清空 局内干员编队。
     * - 侵蚀（或其它非活化）阶段的一律抹除，不入标本库。
     * - **标本库按时间线分组**：本次新入档的干员写进 `标本库[tid]`（tid = 本局剧情归档用的那个编号）。
     * - 从标本库带入的干员（键带 "干员名_编号" 后缀）且**库里已有同键**：原组内「以新换旧」——
     *   她的数据随本次通关更新，但**组号不动**，也就是说她还留在原来那条时间线上（作者拍板）。
     * - 本局内由普通纯名干员晋升进入活化阶段的：分配新后缀，作为"新的一位她"写进本次编号这一组。
     * 熔断/失败不清标本库（只清局内，见 _enterFailedState / _resetRun）。
     * @param {string} tid 本次通关的时间线编号（外层组号；调用方保证它已用 _newTimelineId 选过、未被占用）
     * @returns {number} 实际入档人数
     */
    _archiveRunToSpecimen(tid) {
      const v = readVars(this.win);
      const roster = v['干员编队'] || {};
      // 只结算活化阶段干员；其余抹除
      const names = Object.keys(roster).filter((n) => roster[n] && roster[n].状态 === '活化');
      let archived = 0;
      writeVars(this.win, (d) => {
        // 无论有无活化阶段干员，本局干员/收藏品/晋升记录都必须清空 ——
        // 否则"通关时一个活化阶段干员都没有"会跳过整个 writeVars，把上一局的 干员编队/收藏品 泄漏进第二把
        d['干员编队'] = {};
        d['收藏品'] = {};
        if (d['玩家资源']) d['玩家资源'].已晋升干员 = [];
        names.forEach((name) => {
          const data = JSON.parse(JSON.stringify(roster[name]));
          if (this._putSpecimenDraft(d, tid, name, data)) archived++;
        });
      });
      State.currentLayer = 1;
      State.currentNodeData = null;
      State.defeatedEnemies = null;
      State.battleOver = false;
      State.mapCache = null; // 通关归档：清空内存地图缓存，下局重新生成
      State.gameOpened = false;
      const tidStr = String(tid || '').trim();
      const where = (archived && tidStr) ? ('（已归入时间线 #' + tidStr + '）') : '';
      if (this.win.alert) {
        this.win.alert(`🎉 通关完成！${archived} 名活化阶段干员已录入永久标本库${where}；其余阶段的干员随之消散。`
          + (archived && tidStr
            ? ('\n\n本时间线分配到的世界编号和角色名后缀为: ' + tidStr
              + '\n（此后她们的完整名字是「名字' + tidStr + '」，例如 <阿米娅' + tidStr + '> / {阿米娅' + tidStr + '}；'
              + '正文里提到从标本库带出的她时请带上这个编号后缀。）')
            : ''));
      }
      this.switchView('out_of_game');
      return archived;
    },

    /**
     * 把一名活化干员写进 标本库（draft 版；通关归档与「保存并禁用」共用同一口径，别再各写一份）。
     * **标本身份键 = 干员名 + 本次时间线的四位编号**（如 `阿米娅1234`）——编号本身就说明"她是哪条世界线上的她"，
     * 所以正文里 `阿米娅1234` / `阿米娅5678` / `阿米娅` 天然是三张不同的脸，前端也按完整键分槽立绘。
     *   · 键已带四位编号 **且库里已有同键** → 在**原组**内以新换旧（组号不动 = 她留在原来那条时间线）。
     *   · 其余（纯名 / 旧式 `名_ab` / 过期后缀）→ 键 = 纯名 + tid，写进 tid 这一组。
     *     同一时间线 + 同一名字 = 同一个人，重复归档就是覆写（不会堆出第二份她）。
     *   · tid 为空且不需要回流 → 不入档（返回 ''）。
     * @param {object} d writeVars 的平铺 draft（就地改 d['标本库']）
     * @param {string} tid 本次归档的时间线编号（外层组号）
     * @param {string} name 编队键（纯名 / `名1234` / 旧式 `名_ab`）
     * @param {object} data 她的卡片（会被打上 身份/标本键 并写入）
     * @returns {string} 实际落库的组编号；没写进任何组 → ''
     */
    _putSpecimenDraft(d, tid, name, data) {
      const key0 = String(name || '').trim();
      if (!key0) return '';
      const gid = String(tid == null ? '' : tid).trim();
      if (!d['标本库'] || typeof d['标本库'] !== 'object' || Array.isArray(d['标本库'])) d['标本库'] = {};
      const lib = d['标本库'];
      /** 全库找某个键落在哪个组（找不到 → ''）。 */
      const groupHolding = (k) => {
        const ids = Object.keys(lib);
        for (let i = 0; i < ids.length; i++) {
          const bag = _specBagOf(lib[ids[i]]);
          if (bag && Object.prototype.hasOwnProperty.call(bag, k)) return ids[i];
        }
        return '';
      };
      // ① 标本回流：同键在原组以新换旧（组号不动 → 她还留在那条时间线上）
      if (isSpecimenKey(key0)) {
        const home = groupHolding(key0);
        if (home) {
          data.身份 = '标本'; data.标本键 = key0;   // 标本身份落库（覆盖同键标本条目）
          lib[home][key0] = data;
          return home;
        }
      }
      if (!gid) return '';
      if (!_specBagOf(lib[gid])) lib[gid] = {};
      // ② 新标本：键 = 纯名 + 本次编号（旧式 `名_ab` 的后缀在登记时就被抹掉，统一到编号口径）
      const key = cleanName(key0) + gid;
      data.身份 = '标本'; data.标本键 = key;            // 新标本带身份标记
      lib[gid][key] = data;
      return gid;
    },

    /**
     * 存档归档：把本局「剧情日志」整段写进 `$时间线记忆库` 的一条时间线。
     *  · 编号 = 4 位随机数字（0000~9999），与已有存档去重；玩家随时可以口头提到这四个数字。
     *  · 用 draft 直接改（与紧接着的 _resetRunScopedDraft 共用同一次写变量，不额外多写一轮）；
     *  · `$时间线记忆库` 是长线数据，本函数只**追加**，绝不删旧时间线。
     *  · ⚠ 必须在 _resetRunScopedDraft(清空剧情日志) **之前**调用。
     * @param {object} d writeVars 的平铺 draft
     * @param {string} [forceId] 指定编号 —— 通关时由调用方先用 _newTimelineId 选好，
     *        好让**标本库的组号与剧情的时间线编号是同一个**；传了它时即使本局一条剧情都没有
     *        也会建出这条线（本次通关的干员已经按这个编号入档了，两者必须挂在同一条时间线上）。
     *        不传 → 旧口径：随机分配，且没有可搬的条目就不建空线。
     * @returns {string} 时间线编号；没有条目且未指定编号 → ''（不建空时间线）
     */
    _archiveChronicleInto(d, forceId) {
      const forced = String(forceId == null ? '' : forceId).trim();
      const src = (d['剧情日志'] && typeof d['剧情日志'] === 'object' && !Array.isArray(d['剧情日志'])) ? d['剧情日志'] : null;
      const keys = src ? Object.keys(src).filter(isChronicleEntryKey) : [];
      if (!forced && !keys.length) return '';
      const mem = (d['$时间线记忆库'] && typeof d['$时间线记忆库'] === 'object' && !Array.isArray(d['$时间线记忆库'])) ? d['$时间线记忆库'] : {};
      const id = forced || this._newTimelineId(mem);
      const line = {};
      if (src) sortChronicleKeys(keys).forEach((k) => { line[k] = src[k]; });
      mem[id] = line;
      d['$时间线记忆库'] = mem;
      return id;
    },

    /** 生成一个与现有存档不重复的 4 位数字编号（0000~9999 都用满则退化为 addRandom 兜底，不会死循环）。 */
    _newTimelineId(mem) {
      const used = new Set(Object.keys(mem || {}).filter(isChronicleEntryKey));
      for (let i = 0; i < 400; i++) {
        const id = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
        if (!used.has(id)) return id;
      }
      // 极端兜底（已存满 400 次仍撞车 / 万位基本用尽）：按顺序找一个空位
      for (let n = 0; n < 10000; n++) {
        const id = String(n).padStart(4, '0');
        if (!used.has(id)) return id;
      }
      return String(Date.now()).slice(-4);
    },

    // ================= 时间线存档（重玩模式） =================
    //  变量：`$时间线记忆库` = { "<4位编号>": { "年,月,日": 正文 } }（AI 不可见）
    //        `$时间线名称`   = { "<4位编号>": "名字" }              （AI 不可见）
    //        `_当前启用时间线` = "<4位编号>" | ''                    （AI 只读可见）
    //        标本库          = { "<4位编号>": { "干员名_编号": 干员卡 } }（**组号 = 时间线编号**）
    //  分工（作者拍板）：EJS 只负责**读**这些并注入提示词；所有写入一律由前端在这里直接改变量。
    //  界面（唯一入口 = 主城「🫙 标本室」，旧的「💾 存档」按钮已并入并删除）：
    //    · 折叠树：一级行 = 一条时间线；展开后是「时间线」「标本库」两个二级折叠栏；
    //    · 行右侧开关 = 启用/关闭该时间线（互斥）；顶部只显示启用时间线名字 + 保存并禁用；
    //    · 启用 = 重玩：该线正文灌进 剧情日志；保存并禁用 = 活化干员 → 标本库[该编号] + 日志覆写回该编号。

    /** 当前启用的时间线编号（'' = 没在重玩）。 */
    _replayId() {
      try { return String(readVars(this.win)['_当前启用时间线'] || '').trim(); } catch (e) { return ''; }
    },
    /** 是否处于重玩模式（一切"正常探索"入口与收益判定都据此锁定）。 */
    _replayOn() { return !!this._replayId(); },

    /** 读出某条时间线的有序条目数组 [[键, 正文], ...]（世界历升序）。不存在 → null。 */
    _timelineEntries(id) {
      const v = readVars(this.win);
      const mem = (v['$时间线记忆库'] && typeof v['$时间线记忆库'] === 'object' && !Array.isArray(v['$时间线记忆库'])) ? v['$时间线记忆库'] : {};
      const line = mem[id];
      if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
      const keys = sortChronicleKeys(Object.keys(line).filter(isChronicleEntryKey));
      return keys.map((k) => [k, this._chronicleVal(line[k])]);
    },

    /** 时间线行列表（供标本室折叠树渲染）：编号 / 名字 / 条数 / 跨度 / 干员数 / 是否当前启用。
     *  行集合 = `$时间线记忆库` 的编号 ∪ `标本库` 的时间线组号
     *  （有的线只有剧情没有干员、有的线只有干员没有剧情，两边都要出现）。
     *  排序：按该线首条世界历升序；没有剧情的排最后，再按编号字典序。
     *  ⚠ **不把「当前启用」置顶**（作者拍板：顶部只告诉你是谁，找哪条由玩家自己找）。 */
    _timelineList() {
      const v = readVars(this.win);
      const mem = (v['$时间线记忆库'] && typeof v['$时间线记忆库'] === 'object' && !Array.isArray(v['$时间线记忆库'])) ? v['$时间线记忆库'] : {};
      const on = this._replayId();
      const ids = [];
      const seen = new Set();
      const push = (id) => { const s = String(id || '').trim(); if (!s || seen.has(s)) return; seen.add(s); ids.push(s); };
      Object.keys(mem).filter(isChronicleEntryKey).forEach(push);
      specGroups(v).forEach((g) => { if (g.timeline) push(g.id); });
      const list = ids.map((id) => {
        // 当前启用那条取**实时** 剧情日志（与二级栏口径一致：行上的"几条"必须和展开后看到的一样多）
        const entries = this._rowEntries(id);
        const first = entries.length ? chronicleDateLabel(entries[0][0]) : '';
        const last = entries.length ? chronicleDateLabel(entries[entries.length - 1][0]) : '';
        return {
          id: id,
          name: this._specNameOf(v, id),
          count: entries.length,
          ops: specKeysIn(v, id).length,
          span: (first && last ? (first === last ? first : (first + ' — ' + last)) : ''),
          firstParts: chronicleKeyParts(entries.length ? entries[0][0] : ''),
          active: id === on,
        };
      });
      list.sort((a, b) => {
        const pa = a.firstParts, pb = b.firstParts;
        if (pa && pb) { for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } }
        else if (pa || pb) return pa ? -1 : 1;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });
      return list;
    },

    // ================= 标本室 · 时间线折叠树（整页） =================
    //  作者口径（务必别改回去）：
    //   · 顶部**只有**「启用时间线的名字」和「保存并禁用」，不做置顶/跳转/自动滚动；
    //   · 行标题 = `#编号-名字`，编号不可改，点名字就地改名（默认「未命名」）；
    //   · 三级收起到内容：时间线行 → 「时间线」「标本库」两个二级栏 → 真正的条目/卡片；
    //   · 左栏详情栏与干员编队页完全共用（点右侧卡片看左栏），本页只读、不做任何数据改动
    //     （唯一的写操作是：改名 / 启用开关 / 保存并禁用）。

    /** 折叠状态（会话内记忆；默认全收起，关页重开保留）。键：'r:编号' / 's:编号:line' / 's:编号:spec'。 */
    _specOpenMap() {
      if (!State.specOpen || typeof State.specOpen !== 'object') State.specOpen = {};
      return State.specOpen;
    },
    _specIsOpen(key) { return !!this._specOpenMap()[key]; },
    _specToggleOpen(key) { const m = this._specOpenMap(); m[key] = !m[key]; return m[key]; },

    /** 时间线的自定义名字（'' = 没起名）。 */
    _specNameOf(v, id) {
      const m = (v['$时间线名称'] && typeof v['$时间线名称'] === 'object' && !Array.isArray(v['$时间线名称'])) ? v['$时间线名称'] : {};
      return String(m[id] == null ? '' : m[id]).trim();
    },

    /** 行标题：`#编号-名字`（没起名 → 未命名）。 */
    _specTitleOf(v, id) { return '#' + id + '-' + (this._specNameOf(v, id) || '未命名'); },

    /** 写时间线名字（空串 = 清掉，退回「未命名」；只改后半段，编号永远不动）。 */
    _setSpecName(id, name) {
      const key = String(id || '').trim();
      if (!key) return;
      const nm = String(name == null ? '' : name).trim().slice(0, 24);
      writeVars(this.win, (d) => {
        const m = (d['$时间线名称'] && typeof d['$时间线名称'] === 'object' && !Array.isArray(d['$时间线名称'])) ? d['$时间线名称'] : {};
        if (nm) m[key] = nm; else delete m[key];
        d['$时间线名称'] = m;
      });
    },

    /** 某个行要展示的条目：**当前启用那条读实时 剧情日志**（没保存的进度也算她的），其余读 `$时间线记忆库`。 */
    _rowEntries(id) {
      if (id && id === this._replayId()) {
        try { return Array.from(this._chronicleNow().entries()); } catch (e) {}
      }
      return this._timelineEntries(id) || [];
    },

    /** 时间线状态变化后的收尾：主城按钮跟着变（**不走 switchView**，否则每次拨开关都播一遍过场）+ 页面原地重绘。 */
    _afterTimelineChange() {
      try { this._renderHome(); } catch (e) {}
      try { this._syncReplayLocks(); } catch (e) {}
      this._renderSpecimenPage();
    },

    /** 整页：标本室（时间线折叠树）。左栏 = 干员详情；右栏 = 折叠树。 */
    _renderSpecimenPage() {
      const v = readVars(this.win);
      const on = this._replayId();
      const list = this._timelineList();
      const head = this._pageHeadHTML('🫙 标本室',
        (on ? this._specTitleOf(v, on) : (list.length ? ('共 ' + list.length + ' 条时间线') : '')),
        '<button class="mini-btn' + (on ? ' gold' : ' gray') + '" id="sp-save"' + (on ? '' : ' disabled')
        + ' title="' + (on ? ('把本次进度写回 ' + this._esc(this._specTitleOf(v, on)) + ' 并关闭启用') : '需要先在某条时间线上打开开关') + '">保存并禁用</button>');
      const pg = this._openPage(head
        + '<div class="pg-body">'
        + '<div class="pg-side ds-scroll" id="pg-side">' + this._opDetailHTML('', '标本库', State.specMode) + '</div>'
        + '<div class="pg-main ds-scroll" id="pg-main">' + this._specTreeHTML(v, list) + '</div>'
        + '</div>');
      this._bindSpecimenPage(pg);
    },

    /** 折叠树本体：一行行时间线（默认收起），末尾是 AI 写歪的异常组（只读）。 */
    _specTreeHTML(v, list) {
      const anomaly = specAnomalyGroups(v);
      if (!list.length && !anomaly.length) {
        return '<div class="pg-empty">标本室空空如也。<br>通关结算时，活化阶段的干员们会自己走进来。</div>';
      }
      const rows = list.map((t) => {
        const open = this._specIsOpen('r:' + t.id);
        const bits = [t.count + ' 条'];
        if (t.span) bits.push(t.span);
        if (t.ops) bits.push(t.ops + ' 位干员');
        const canUse = t.count > 0;
        const tglTitle = !canUse ? '这条时间线还没有剧情记录，不能启用重玩'
          : (t.active ? '关闭 = 退出重玩（会警告）' : '打开 = 启用这条时间线重玩');
        return '<div class="sp-row' + (open ? ' open' : '') + (t.active ? ' on' : '') + '" data-row="' + this._esc(t.id) + '">'
          + '<div class="sp-head">'
          + '<span class="sp-arrow">▸</span>'
          + '<span class="sp-title">' + this._esc(this._specTitleOf(v, t.id)) + '</span>'
          + '<button class="sp-edit" type="button" data-rename="' + this._esc(t.id) + '"'
          + ' title="改名字（编号固定，只改后半段）">✎</button>'
          + (t.active ? '<span class="sp-live">重玩中</span>' : '')
          + '<span class="sp-meta">' + this._esc(bits.join('　·　')) + '</span>'
          + '<span class="sp-spacer"></span>'
          + '<button class="sp-tgl' + (t.active ? ' on' : '') + (canUse ? '' : ' lock') + '" type="button" role="switch"'
          + ' data-tgl="' + this._esc(t.id) + '" aria-checked="' + (t.active ? 'true' : 'false') + '" title="' + tglTitle + '">'
          + '<span class="sp-knob"></span></button>'
          + '</div>'
          + '<div class="sp-body">' + this._specLineSubHTML(t) + this._specSpecSubHTML(v, t) + '</div>'
          + '</div>';
      }).join('');
      return '<div class="sp-tree">' + rows + this._specAnomalyHTML(anomaly) + '</div>';
    },

    /** 二级栏①：时间线（剧情日志，正序，复用时间轴样式）。 */
    _specLineSubHTML(t) {
      const open = this._specIsOpen('s:' + t.id + ':line');
      const live = (t.id === this._replayId());
      const entries = this._rowEntries(t.id);
      const body = entries.length
        ? '<div class="tl">' + entries.map(([k, val]) => '<div class="tl-item">'
            + '<span class="tl-dot"></span>'
            + '<div class="tl-body"><div class="tl-date">' + this._esc(chronicleDateLabel(k)) + '</div>'
            + '<div class="tl-text">' + this._esc(val || '（空）') + '</div></div></div>').join('') + '</div>'
        : '<div class="sp-note">这条时间线还没有剧情记录。</div>';
      return '<div class="sp-sub' + (open ? ' open' : '') + '" data-sub="' + this._esc(t.id) + ':line">'
        + '<div class="sp-subhead"><span class="sp-arrow">▸</span>'
        + '<span class="sp-subname">时间线</span><span class="sp-count">' + entries.length + '</span>'
        + (live ? '<span class="sp-live">实时·未保存</span>' : '') + '</div>'
        + '<div class="sp-subbody">' + body + '</div></div>';
    },

    /** 二级栏②：标本库（这条时间线下的干员宽卡；点卡看左栏详情）。 */
    _specSpecSubHTML(v, t) {
      const open = this._specIsOpen('s:' + t.id + ':spec');
      const bag = _specBagOf(_specLib(v)[t.id]) || {};
      const keys = Object.keys(bag).filter(isChronicleEntryKey)
        .sort((a, b) => cleanName(a).localeCompare(cleanName(b), 'zh'));
      const body = keys.length
        ? '<div class="du-grid">' + keys.map((k) => this._opCardHTML(k, bag[k] || {}, k === State.specSel, true)).join('') + '</div>'
        : '<div class="sp-note">这条时间线还没有归档干员。</div>';
      return '<div class="sp-sub' + (open ? ' open' : '') + '" data-sub="' + this._esc(t.id) + ':spec">'
        + '<div class="sp-subhead"><span class="sp-arrow">▸</span>'
        + '<span class="sp-subname">标本库</span><span class="sp-count">' + keys.length + '</span></div>'
        + '<div class="sp-subbody">' + body + '</div></div>';
    },

    /** 异常组（AI 把卡片写到非四位数字的组里 / 手工改坏）：只读展示，便于一眼发现数据写歪。 */
    _specAnomalyHTML(anomaly) {
      if (!anomaly.length) return '';
      const open = this._specIsOpen('s:anomaly');
      const total = anomaly.reduce((n, g) => n + Object.keys(g.bag).filter(isChronicleEntryKey).length, 0);
      const inner = anomaly.map((g) => {
        const keys = Object.keys(g.bag).filter(isChronicleEntryKey);
        return '<div class="sp-note">组「' + this._esc(g.id) + '」：' + (keys.length ? keys.map((k) => this._esc(k)).join('、') : '（空）') + '</div>';
      }).join('');
      return '<div class="sp-row sp-anomaly' + (open ? ' open' : '') + '">'
        + '<div class="sp-head" data-anomaly="1">'
        + '<span class="sp-arrow">▸</span>'
        + '<span class="sp-title sp-title-dim">异常组（组名不是四位时间线编号，只读）</span>'
        + '<span class="sp-meta">' + anomaly.length + ' 组 · ' + total + ' 张卡</span>'
        + '<span class="sp-spacer"></span></div>'
        + '<div class="sp-body"><div class="sp-sub open"><div class="sp-subbody">' + inner + '</div></div></div></div>';
    },

    /** 绑定标本室页的全部交互（页面每次重绘都重绑；状态都在 State 里，所以重绘不丢）。 */
    _bindSpecimenPage(pg) {
      const side = pg.querySelector('#pg-side');
      const main = pg.querySelector('#pg-main');

      const bindTabs = () => {
        side.querySelectorAll('.dt-tab').forEach((t) => {
          t.onclick = () => { State.specMode = t.dataset.m === 'narr' ? 'narr' : 'num'; paintSide(); };
        });
        // 标本库专用：精一/精二胸像切换（仅前端查阅，不动变量）
        side.querySelectorAll('.dt-art').forEach((b) => {
          b.onclick = () => { this._specElite = b.dataset.e === '1'; paintSide(); };
        });
        // 标本库专用：改名字（编号固定，只改后半段）
        side.querySelectorAll('[data-sp-rename]').forEach((b) => {
          b.onclick = () => this._renameSpecimen(b.dataset.spRename);
        });
      };
      const paintSide = () => { side.innerHTML = this._opDetailHTML(State.specSel, '标本库', State.specMode); bindTabs(); };
      paintSide();

      // ① 一级行：点行头（含标题）= 展开/收起；✎ = 就地改名；右侧开关 = 启用/关闭（互斥）。
      main.querySelectorAll('.sp-row[data-row]').forEach((row) => {
        const id = row.dataset.row;
        const head = row.querySelector('.sp-head');
        if (head) head.onclick = (e) => {
          if (e.target.closest('.sp-tgl') || e.target.closest('.sp-edit') || e.target.closest('input')) return;
          this._specToggleOpen('r:' + id);
          this._renderSpecimenPage();
        };
      });
      // ② 二级栏：点栏头展开/收起（不重绘整页，只翻 class，手感更稳）
      main.querySelectorAll('.sp-subhead').forEach((sh) => {
        sh.onclick = () => {
          const sub = sh.parentNode;
          if (!sub || !sub.dataset || !sub.dataset.sub) return;
          const open = this._specToggleOpen('s:' + sub.dataset.sub);
          sub.classList.toggle('open', !!open);
        };
      });
      // ③ 异常组行：只读，点一下翻看内容
      main.querySelectorAll('.sp-head[data-anomaly]').forEach((sh) => {
        sh.onclick = () => {
          const open = this._specToggleOpen('s:anomaly');
          const row = sh.parentNode;
          if (row) row.classList.toggle('open', !!open);
        };
      });
      // ④ 启用开关（互斥）：开 = 启用重玩；关当前启用的 = 警告后丢弃进度；换线 = 三键询问
      main.querySelectorAll('[data-tgl]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          if (b.classList.contains('lock')) return;
          this._onSpecSwitch(b.dataset.tgl);
        };
      });
      // ⑤ 改名（✎）：点 ✎ → 标题原地变输入框（编号固定不可改），回车/失焦保存，Esc 取消
      main.querySelectorAll('.sp-edit[data-rename]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const row = btn.closest ? btn.closest('.sp-row') : null;
          const title = row ? row.querySelector('.sp-title') : null;
          if (!title || title.dataset.editing === '1') return;
          this._beginSpecRename(title, btn.dataset.rename);
        };
      });
      // ⑥ 干员卡：点卡选中 → 左栏详情（再点同一张 = 取消选中）
      main.querySelectorAll('.du-card').forEach((card) => {
        card.onclick = () => {
          const k = card.dataset.k || '';
          State.specSel = (k === State.specSel) ? '' : k;
          main.querySelectorAll('.du-card').forEach((c) => c.classList.toggle('sel', c.dataset.k === State.specSel));
          paintSide();
        };
      });
      // ⑦ 顶部「保存并禁用」= 保存并退出重玩（活化干员 → 标本库[该编号]，日志覆写回该编号）
      const sv = pg.querySelector('#sp-save');
      if (sv) sv.onclick = () => this._saveReplayAndQuit();
    },

    /** 原地改行标题：编号固定，只让玩家改后半段名字。 */
    _beginSpecRename(el, id) {
      const v = readVars(this.win);
      el.dataset.editing = '1';
      try { el.classList.add('editing'); } catch (e) {}
      el.innerHTML = '<span class="sp-hash">#' + this._esc(id) + '-</span>'
        + '<input class="sp-rename" type="text" maxlength="24" placeholder="未命名" name="jczl-tl-name-noautofill"'
        + ' autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"'
        + ' data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other"'
        + ' value="' + this._esc(this._specNameOf(v, id)) + '">';
      const inp = el.querySelector('.sp-rename');
      if (!inp) return;
      const done = (commit) => {
        if (el.dataset.editing !== '1') return;
        el.dataset.editing = '0';
        try { el.classList.remove('editing'); } catch (e) {}
        if (commit) this._setSpecName(id, inp.value);
        // 只就地还原标题文字，**不整页重绘** ——
        //   否则"点✕关闭 → 输入框 blur → 重绘 → 页面又冒出来"、以及"点别的行 → blur 重绘把这次点击吃掉"。
        const title = this._specTitleOf(readVars(this.win), id);
        el.textContent = title;
        try {
          const sub = this.win.document.querySelector('#game-page .pg-sub');   // 顶部那行只在启用那条上显示名字
          if (sub && id === this._replayId()) sub.textContent = title;
        } catch (e) {}
      };
      inp.onclick = (e) => e.stopPropagation();
      inp.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        else if (e.key === 'Escape') { e.preventDefault(); done(false); }
      };
      inp.onblur = () => done(true);
      setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) {} }, 0);
    },

    /**
     * 给**标本**改名字：只改名字部分，四位编号后缀固定（`阿米娅1234` → `小阿米娅1234`）。
     *   · 编号不变 = 她还是同一条世界线上的同一个她，异构体区分不受影响；
     *   · 首次改名把她原来的纯名记进 `原名`，立绘图链靠它回退（不然"小阿米娅"在角色库里查不到图）；
     *   · 她若正在本局 干员编队 里（重玩中改名），编队键跟着改，别让她凭空变成"另一个野生角色"。
     */
    async _renameSpecimen(key) {
      const k = String(key || '').trim();
      if (!k) return;
      const v = readVars(this.win);
      const hit = specFindExact(v, k);
      if (!hit) { this._uiAlert('找不到这条标本记录（可能刚被改动过）。', '改名字'); return; }
      const tid = hit.id;
      const res = await this._uiPrompt({
        title: '✎ 改名字',
        body: '编号 #' + tid + ' 固定不变，只改名字部分。\n改完正文里叫她 <名字' + tid + '> / {名字' + tid + '} 就行。',
        value: cleanName(k),
        placeholder: '例如：小阿米娅',
      });
      if (res == null) return;
      let base = String(res).trim();
      // 玩家自己把后缀也打进来了 → 去掉，避免出现 小阿米娅1234 1234
      base = base.replace(/\d{4}$/, '').replace(/_[0-9a-z]{2}$/, '').trim();
      if (!base) { this._uiAlert('名字不能为空。', '改名字'); return; }
      if (base.length > 20) base = base.slice(0, 20);
      const newKey = base + tid;
      if (newKey === k) return;
      const bag = _specBagOf(_specLib(v)[tid]) || {};
      if (Object.prototype.hasOwnProperty.call(bag, newKey)) {
        this._uiAlert('这条时间线里已经有「' + base + '」了，换个名字。', '改名字');
        return;
      }
      let done = false;
      writeVars(this.win, (d) => {
        const lib = (d['标本库'] && typeof d['标本库'] === 'object' && !Array.isArray(d['标本库'])) ? d['标本库'] : null;
        const g = lib ? _specBagOf(lib[tid]) : null;
        if (!g || !g[k]) return;
        const data = g[k];
        if (!data.原名) data.原名 = cleanName(k);   // 首次改名记下原名（立绘图源靠它回退）
        data.标本键 = newKey;
        delete g[k];
        g[newKey] = data;
        const roster = d['干员编队'];
        if (roster && typeof roster === 'object' && !Array.isArray(roster) && roster[k]) {
          roster[newKey] = roster[k];
          delete roster[k];
        }
        done = true;
      });
      if (!done) { this._uiAlert('改名失败：记录已经不在了。', '改名字'); return; }
      State.specSel = newKey;
      this._renderSpecimenPage();
    },

    /**
     * 拨某条时间线的开关（互斥）。
     *   · 关掉**当前启用**的那条 → 走 _disableReplay 的丢弃警告（存档内容不动）。
     *   · 开一条、当前没有启用 → 直接启用（_useTimeline）。
     *   · 开一条、但正在重玩另一条且进度未保存 → 三键询问：丢弃并切换 / 先保存 A 再切 / 取消。
     *   · 0 条剧情的线不能启用（开关本身就是置灰的，这里再兜一道）。
     */
    async _onSpecSwitch(id) {
      const key = String(id || '').trim();
      if (!key) return;
      const on = this._replayId();
      if (on === key) { await this._disableReplay(); return; }
      const entries = this._timelineEntries(key) || [];
      if (!entries.length) { this._uiAlert('这条时间线还没有剧情记录，不能启用重玩。', '标本室'); return; }
      if (!on) { this._useTimeline(key); return; }
      const v = readVars(this.win);
      const pick = await this._uiChoose({
        title: '切换时间线',
        body: '当前正在重玩 ' + this._specTitleOf(v, on) + '，这份进度还没保存。\n\n'
          + '切到 ' + this._specTitleOf(v, key) + ' 之前，先决定前一份怎么处理：',
        okText: '',
        buttons: [
          { key: 'cancel', text: '取消', cls: 'gray' },
          { key: 'save', text: '先保存 ' + this._specTitleOf(v, on) + ' 再切', cls: 'gold' },
          { key: 'drop', text: '丢弃它的进度并切换', cls: 'gray' },
        ],
      });
      if (pick === 'save') {
        this._saveReplayAndQuit({ quiet: true });
        this._useTimeline(key);
      } else if (pick === 'drop') {
        this._useTimeline(key);           // _useTimeline 内部先 _resetRunScopedDraft，等于丢弃前一份
      }
    },

    /**
     * 启用某条时间线（重玩）：干净本局 → 该线正文灌进 `剧情日志` → 记 `_当前启用时间线`。
     * ⚠ 顺序不能反：_resetRunScopedDraft 会清空 剧情日志，所以先复位再灌。
     */
    _useTimeline(id) {
      const key = String(id || '').trim();
      const entries = this._timelineEntries(key);
      if (!entries || !entries.length) { this._uiAlert('这条时间线是空的（没有可重放的剧情日志）。', '存档'); return; }
      const line = {};
      entries.forEach(([k, val]) => { line[k] = val; });
      writeVars(this.win, (d) => {
        this._resetRunScopedDraft(d);          // 干净本局：经济/编队/收藏品/地图/切片 全复位
        d['剧情日志'] = line;                   // 再把该线正文灌进本局流水（AI 可读）
        d['_当前启用时间线'] = key;             // 重玩闸：EJS 读它 → 注入模式提示词
      });
      State.currentLayer = 1;
      State.currentNodeData = null;
      State.nodeType = '';
      State.mapCache = null;
      State.gameOpened = true;
      State.chronicleFp = null;                 // 日志快照重建，避免把"灌入"当成本回合新增去播报
      try { State.chronicleFp = this._chronicleNow(); } catch (e) {}
      this._replaySnapTake();                   // 重建兜底快照基线
      this._afterTimelineChange();              // 主城按钮跟着变 + 标本室页原地重绘（不关页、不播过场）
      this._uiAlert('已启用 ' + this._specTitleOf(readVars(this.win), key) + '（共 ' + entries.length + ' 条）。\n\n'
        + '现在是重玩模式：纯剧情体验，没有战斗与节点判定，不产出任何收益。\n'
        + '关掉这个页面，直接在下面的输入框开聊即可；\n'
        + '想保存这次进度，回「🫙 标本室」点顶部的「保存并禁用」。', '标本室');
    },

    /** 切到「无」：警告后丢弃本次进度（`$时间线记忆库` 里的旧存档一个字节都不动）。 */
    async _disableReplay() {
      const on = this._replayId();
      if (!on) return;
      const ok = await this._uiConfirm(
        '确定要关掉这条时间线的开关吗？\n\n'
        + '· 直接关掉会**丢失本次重玩的一切进度**（本次写的剧情日志、新收服的干员、这段对话都不会保存）。\n'
        + '· 存档里 ' + this._specTitleOf(readVars(this.win), on) + ' 的内容**保持上次保存的样子，不会被修改**。\n'
        + '· 只有觉得当前进度不满意、想放弃它时，才推荐这样关闭。\n'
        + '· 想留下这次进度 → 点「取消」，改用顶部的「保存并禁用」。\n\n'
        + '仍然关掉（丢弃当前进度）？', '切换时间线');
      if (!ok) return;
      writeVars(this.win, (d) => {
        d['_当前启用时间线'] = '';
        this._resetRunScopedDraft(d);           // 丢进度：连本局剧情日志一起清
      });
      State.currentLayer = 1;
      State.currentNodeData = null;
      State.nodeType = '';
      State.mapCache = null;
      State.gameOpened = false;
      State.chronicleFp = null;
      this._replaySnapClear();
      this._afterTimelineChange();
      this._uiAlert('已关闭——本次重玩进度已丢弃，时间线 #' + on + ' 仍是上次保存的样子。', '标本室');
    },

    /**
     * 保存并禁用（重玩专用，按钮在标本室页顶部）：活化干员 → 标本库[该编号]；本局剧情日志**覆写**回该编号；
     * 然后清本局、解除启用、页面原地重绘。整个过程一次 writeVars 写完，不留中间态。
     * @param {{quiet?:boolean}} [opts] quiet = 不弹「已保存」提示（切换时间线时用）
     * @returns {{id:string, archived:number, entries:number}|null} 没在重玩 → null
     */
    _saveReplayAndQuit(opts) {
      const o = opts || {};
      const id = this._replayId();
      if (!id) { this._uiAlert('当前没有启用任何时间线，没有可保存的重玩进度。', '标本室'); return null; }
      const v = readVars(this.win);
      const log = v['剧情日志'] || {};
      const entries = sortChronicleKeys(Object.keys(log).filter(isChronicleEntryKey)).map((k) => [k, log[k]]);
      let archived = 0;
      writeVars(this.win, (d) => {
        // ① 活化干员进标本库[id]（与通关归档同一口径：同键回流留在原组，纯名的按本次编号新分配后缀）
        const roster = d['干员编队'] || {};
        const names = Object.keys(roster).filter((n) => roster[n] && roster[n].状态 === '活化');
        names.forEach((name) => {
          const data = JSON.parse(JSON.stringify(roster[name]));
          if (this._putSpecimenDraft(d, id, name, data)) archived++;
        });
        // ② 本局剧情日志覆写回该编号（同名覆盖，不是新开一条）
        if (entries.length) {
          const mem = (d['$时间线记忆库'] && typeof d['$时间线记忆库'] === 'object' && !Array.isArray(d['$时间线记忆库'])) ? d['$时间线记忆库'] : {};
          const line = {};
          entries.forEach(([k, val]) => { line[k] = val; });
          mem[id] = line;
          d['$时间线记忆库'] = mem;
        }
        // ③ 解除启用 + 清本局
        d['_当前启用时间线'] = '';
        this._resetRunScopedDraft(d);
      });
      State.currentLayer = 1;
      State.currentNodeData = null;
      State.nodeType = '';
      State.mapCache = null;
      State.gameOpened = false;
      State.chronicleFp = null;
      this._replaySnapClear();
      this._afterTimelineChange();
      if (!o.quiet) {
        this._uiAlert('已保存并关闭启用：\n\n'
          + '· ' + this._specTitleOf(readVars(this.win), id) + ' 已用本次进度覆写（共 ' + entries.length + ' 条记录）\n'
          + '· ' + archived + ' 名活化干员已录入标本库\n'
          + '· 已切回正常模式（重玩已结束）', '标本室');
      }
      return { id: id, archived: archived, entries: entries.length };
    },

    // ---- 重玩模式的兜底（提示词不可靠，前端做硬保险）-----------------------------
    //  · 快照：进入重玩时记下 玩家资源 / 收藏品 / 蚀刻章，每回合比对，被 AI 改了就用快照写回。
    //  · 新收干员：本回合新增的编队键一律强制 状态='活化'（重玩模式不需要晋升）。
    //  · 一旦纠正过，下一条出站消息前置一段隐藏提示（见 _withReplayFix），让 AI 当作无事发生。
    _replaySnapTake() {
      try {
        const v = readVars(this.win);
        State.replaySnap = {
          玩家资源: JSON.parse(JSON.stringify(v['玩家资源'] || {})),
          收藏品: JSON.parse(JSON.stringify(v['收藏品'] || {})),
          蚀刻章: JSON.parse(JSON.stringify(v['蚀刻章'] || {})),
          编队键: Object.keys(v['干员编队'] || {}),
        };
      } catch (e) { State.replaySnap = null; }
    },
    _replaySnapClear() { State.replaySnap = null; State.replayFixPending = false; },

    /** 每回合（AI 回复后）纠偏；返回是否真的纠正过。 */
    _replayDriftCheck() {
      if (!this._replayOn()) return false;
      if (!State.replaySnap) { this._replaySnapTake(); return false; }
      const snap = State.replaySnap;
      const v = readVars(this.win);
      const str = (o) => { try { return JSON.stringify(o || {}); } catch (e) { return ''; } };
      const resNow = str(v['玩家资源']), resSnap = str(snap.玩家资源);
      const colNow = str(v['收藏品']), colSnap = str(snap.收藏品);
      const etchNow = str(v['蚀刻章']), etchSnap = str(snap.蚀刻章);
      // 新增的编队键（本回合新收的人）中状态不是活化的
      const roster = v['干员编队'] || {};
      const before = new Set(snap.编队键 || []);
      const needActive = Object.keys(roster).filter((k) => !before.has(k) && roster[k] && roster[k].状态 !== '活化');

      let fixed = false;
      try {
        writeVars(this.win, (d) => {
          if (resNow !== resSnap) { d['玩家资源'] = JSON.parse(resSnap); fixed = true; }
          if (colNow !== colSnap) { d['收藏品'] = JSON.parse(colSnap); fixed = true; }
          if (etchNow !== etchSnap) { d['蚀刻章'] = JSON.parse(etchSnap); fixed = true; }
          if (!d['干员编队']) d['干员编队'] = {};
          needActive.forEach((k) => {
            const rec = d['干员编队'][k];
            if (!rec || typeof rec !== 'object') return;
            rec.状态 = '活化';
            rec.已晋升 = true;      // 活化即"已完成晋升"的语义，重玩模式不再收费
            fixed = true;
          });
        });
      } catch (e) { return false; }
      if (fixed) State.replayFixPending = true;
      // 快照重建：无论是否纠正，都按"当前已合规的状态"续存
      this._replaySnapTake();
      if (fixed) console.info('[集成战略] 重玩模式已纠正越权改动（经济/收藏品/蚀刻章/未活化干员），下一条消息会附隐藏说明。');
      return fixed;
    },

    /** 给一条出站消息前置"前文可能出错已修复"的隐藏提示（只发一次） */
    _withReplayFix(text) {
      const t = String(text || '');
      try {
        if (!State.replayFixPending) return t;
        const note = this._sys('前文可能存在错误, 比如误在重玩模式下修改了经济, 或干员收服后不是立刻活化阶段. '
          + '问题已修复, 你不需要操作也不需要在剧情中特意指出, 保持正确描写, 当作无事发生继续剧情即可');
        if (t.indexOf('前文可能存在错误') !== -1) return t;   // 幂等
        State.replayFixPending = false;
        return note + '\n' + t;
      } catch (e) { return t; }
    },

    /** 状态机路由：切换主视图 */
    switchView(status) {
      State.currentStatus = status;
      // 换视图 = 上一幕彻底结束 → 失败锁定态一并解除（防"回了主页还锁着按钮 / 横幅残留"）。
      try { this._clearFailedState(); } catch (e) {}
      this._closePage();   // 兜底：换视图（进/离节点、回主城、编队）时不许整页浏览器残留盖住新画面
      // 地图节点确认栏只属于"站在地图上选节点"这一幕，换视图一律收起（进地图时由 renderMap 重建）
      try { this._closeNodeConfirm(true); } catch (e) {}
      // 换视图＝上一幕结束：停打字机并清空 Galgame 窗口，避免上一节点的正文残留在新画面上。
      // 随后 loadHistoryChat → _renderChatWindow 会用最新一条 AI 正文把窗口重新铺上。
      try { this._galClear(); } catch (e) {}
      this._persistGameState(this.win);
      this._recomputeLongPool();
      const main = this.win.document.getElementById('main-content');
      const oldHud = this.win.document.getElementById('node-hud');
      if (oldHud) oldHud.remove();
      const oldStage = this.win.document.getElementById('node-stage');
      if (oldStage) oldStage.remove();
      const oldRail = this.win.document.getElementById('option-rail');
      if (oldRail) oldRail.remove();
      // 诡意行商「确认购买」按钮是独立的 body 级浮层（不挂在 rail 里，才能盖住雷达），换视图时单独摘掉
      try { this._removeShopBuyBtn(); } catch (e) {}
      this._shopPending = false;   // 「已提交」待机态只属于这个节点，换视图即复位
      // 主城打开过场（旧背景铺底 + 标题文字）：一旦离开主城立刻摘掉，
      // 否则玩家在 3.2s 内点「出门探索」时，那张整屏旧背景会盖在编队界面上继续淡出。
      // 回主城时由 switchView('out_of_game') → _playHomeSplash 重新播一遍。
      if (status !== 'out_of_game') {
        const oldSplash = this.win.document.getElementById('home-splash');
        if (oldSplash) oldSplash.remove();
        const oldTitle = this.win.document.getElementById('title-splash');
        if (oldTitle) oldTitle.remove();
      }
      this.body.classList.remove('has-option-rail');
      this.body.classList.toggle('in-map', status === 'map_navigation');
      // 编队大画布（body.in-prep）只由 _renderPreparation 在「基底干员」那一步挂上；
      // 这里统一摘掉，免得换视图时把它带到别处（「选择分队」那页保持改前原样）。
      this.body.classList.remove('in-prep');
      this.body.classList.toggle('in-chat-left', false);
      this.body.classList.remove('in-node-ui');
      this._syncBaseGateBtn();   // 战斗门同步：作战节点收服前锁定「设基底」，其它视图一律解锁
      if (!main) return;
      this.updateBackground();
      this.refreshStats();
      this._syncReplayLocks();   // 重玩模式：顶栏熔断/设基底 的锁定随视图同步
      if (status === 'preparation') { this._renderPreparation(main); return; }
      if (status === 'map_navigation') { this.renderMap(main); return; }
      if (status === 'event_node') {
        // 统一节点视图：聊天全屏（右侧选项栏出正文选项），顶部细 HUD 只放节点信息。
        // 离开入口口径：仅「诡意行商」在 HUD 保留顶端「离开节点」按钮（非作战、恒可用）；
        // 其余节点的离开伪装成右侧选项栏常驻的合成离开卡（见 _showLeaveCard / _ensureLeaveCard），
        // 战斗类节点在主目标收服前该卡不渲染（门控 _nodeCanLeave）。
        const v = readVars(this.win);
        const ni = v['$切片'] || {};
        const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : {};
        const type = nd.type || State.nodeType || '剧情节点';
        const year = ni.$当前时间点;
        const enemy = ni.$当前敌方 || '';
        // 进节点 = 高层覆盖：清掉地图主区，铺一层"节点舞台"（默认 CG / 目标角色背景），聊天托盘仍在底下不动。
        main.innerHTML = '';
        const stage = this.win.document.createElement('div');
        stage.id = 'node-stage';
        this.win.document.body.appendChild(stage);
        this._setNodeStageBg(enemy || '');
        const hud = this.win.document.createElement('div');
        hud.id = 'node-hud';
        hud.style.cssText = 'position:fixed;top:calc(var(--bar-h, 48px) + 4px);left:50%;transform:translateX(-50%);z-index:300;display:flex;align-items:center;gap:10px;background:rgba(10,12,16,.82);border:1px solid rgba(150,170,210,.35);border-radius:22px;padding:5px 14px;font-size: max(11px, calc(13px + var(--fs-d, 0px)));color:#e8e6e0;box-shadow:0 4px 14px rgba(0,0,0,.45);flex-wrap:wrap;justify-content:center';
        hud.innerHTML = `<span style="color:#ffd98c;font-weight:bold">${type}</span>`
          + (year && type !== '诡意行商' ? `<span style="color:#9aa3b0;font-size: max(11px, calc(11px + var(--fs-d, 0px)))">时间点 ${year}</span>` : '')
          + (enemy ? `<span style="color:#ffb4a0;font-size: max(11px, calc(12px + var(--fs-d, 0px)))">目标：${enemy}</span>` : '')
          + (ni.$锁定 ? '<span style="color:#ff9f43">已收束·只能离开</span>' : '')
          + (type === '诡意行商' ? `<button class="mini-btn gray" id="node-leave-btn" style="padding:3px 10px">离开节点</button>` : '');
        this.win.document.body.appendChild(hud);
        const lv = this.win.document.getElementById('node-leave-btn');
        if (lv) {
          const isShop = type === '诡意行商';
          lv.onclick = () => {
            if (State.busyPhase === 'generating') return;
            // 诡意行商：离开按钮与商品多选共用一套"点选 → 再点执行"，且两者互斥。
            //   第一击＝选中（顺手清空全部商品勾选），第二击＝真正离开；未选中的再点只改选中态，不发消息。
            if (isShop) {
              if (this._shopPickLeave()) return;
            }
            this._leaveNode();
          };
        }
        if (ni.$锁定) {
          const il = this.win.document.getElementById('chat-input');
          const sb = this.win.document.getElementById('chat-send');
          if (il) il.readOnly = true;
          if (sb) sb.disabled = true;
        }
        // 节点内常驻离开卡：进节点即渲染（战斗主目标未收服则不出现；无正文选项时只此一张卡）
        this._ensureLeaveCard();
        // 诡意行商：购物控制面板从进节点起就常驻右下角（整块盖住三轴雷达），
        // 不等第一次 AI 回复 —— 否则"进节点 → 首个回复"之间雷达会闪一下再被盖住。
        if (type === '诡意行商') this._ensureShopBuyBtn();
        return;
      }
      // out_of_game 主城：**进主城这一刻**播打开过场（旧背景 + 标题一起淡出），再画界面。
      // ⚠ 过场只能挂在这里，不能挂进 _renderHome：难度轮盘点「确认」也会调 _renderHome 重绘
      //   （为了刷新难度数字），挂那儿会导致每次选完难度都重播一遍过场。
      this._playHomeSplash();
      this._renderHome();
    },

    /**
     * 初始界面（主城）：开始游戏旁挂一个"难度数字按钮"，点开为全屏上下滑动轮盘。
     * 难度只是前端叠加的效果；真正的应用与写入变量发生在「确认并出发」时（_applyRunDifficulty）。
     * 纯重绘函数：**不播过场**（过场由 switchView 在进主城时统一触发）。
     */
    _renderHome() {
      const main = this.win.document.getElementById('main-content');
      if (!main) return;
      const saved = Math.trunc(Number((readVars(this.win)['$难度'] || {}).档位));
      const sel = Number.isFinite(State.pendingDifficulty) ? State.pendingDifficulty : (Number.isFinite(saved) ? Math.max(0, saved) : 1);
      const inert = sel === 0;   // 难度 0：一切不变
      // 重玩模式：正常探索的入口（出门探索 / 难度 / 短对局）全部锁死，只留标本室（含存档）/ 干员开关
      const replay = this._replayOn();
      const replayId = this._replayId();
      // 短对局开关：内存已点过就用内存，否则跟随变量 `$短对局`（上次出门的选择）
      const shortOn = (State.pendingShortRun != null) ? !!State.pendingShortRun : this._shortRunOn();
      // 主界面保持克制：不放任何旁白/世界观文案，只有出发入口与标本室。
      main.innerHTML = `
        <div class="home-view">
          <div class="home-deco"></div>
          <div class="home-side">
            <div class="home-short-row${shortOn ? ' on' : ''}${replay ? ' gate-locked' : ''}" id="home-short-row"
                 title="${replay ? '重玩模式：短对局已锁定' : '短对局：只走第 1、3、5 层（跳过 2/4 层），更快通关'}">
              <span class="hs-label">短对局</span>
              <button class="hs-switch${shortOn ? ' on' : ''}" id="home-short" type="button" role="switch"
                      aria-checked="${shortOn ? 'true' : 'false'}" aria-label="短对局">
                <span class="hs-knob"></span>
              </button>
            </div>
            <button class="big-btn btn-gray" id="home-custom">⚙ 干员开关</button>
            <div class="home-go-row">
              <button class="big-btn btn-gold${replay ? ' gate-locked' : ''}" id="home-go"${replay ? ' disabled title="重玩模式：正常探索已锁定"' : ''}>🚪 出门探索</button>
              <button class="diff-num-btn${inert ? ' inert' : ''}${replay ? ' gate-locked' : ''}" id="home-diff" title="${replay ? '重玩模式：难度已锁定' : '选择难度'}">
                <span class="dnb-cap">难度</span><span class="dnb-num">${this._romanDiff(sel)}</span>
              </button>
            </div>
            <div class="home-archive-row">
              <button class="big-btn btn-gray${replay ? ' btn-replay-on' : ''}" id="home-collect"
                title="${replay ? ('重玩中：' + this._esc(this._specTitleOf(readVars(this.win), replayId)) + ' · 点开可保存并禁用') : '标本室 · 按时间线归档的收藏与存档'}">🫙 标本室${replay ? ' · 重玩中' : ''}</button>
            </div>
          </div>
        </div>`;
      const goBtn = this.win.document.getElementById('home-go');
      if (goBtn) goBtn.onclick = () => {
        if (this._replayOn()) { this._uiAlert('重玩模式下不能出门探索。\n\n想恢复正常探索，请到「🫙 标本室」点顶部的「保存并禁用」，或把那条时间线的开关关掉。', '重玩模式'); return; }
        State.prepStep = 'squad'; this.switchView('preparation');
      };
      // 短对局滑块：只改内存暂存值（真正的落变量在「确认并出发」时，和难度同一套时序）。
      //   ⚠ 整行都可点（标签 + 滑块），手机上好按；重玩模式下列为 gate-locked，点了不生效。
      const shortRow = this.win.document.getElementById('home-short-row');
      if (shortRow) shortRow.onclick = () => {
        if (this._replayOn()) { this._uiAlert('重玩模式不需要短对局：这里没有正常探索流程。', '重玩模式'); return; }
        const next = !(State.pendingShortRun != null ? State.pendingShortRun : this._shortRunOn());
        State.pendingShortRun = next;
        shortRow.classList.toggle('on', next);
        const sw = this.win.document.getElementById('home-short');
        if (sw) { sw.classList.toggle('on', next); sw.setAttribute('aria-checked', next ? 'true' : 'false'); }
      };
      const colBtn = this.win.document.getElementById('home-collect');
      // 标本室 = 时间线折叠树整页（原「💾 存档」页已并入这里：开关启用重玩、顶部保存并禁用）
      if (colBtn) colBtn.onclick = () => this._renderSpecimenPage();
      const diffBtn = this.win.document.getElementById('home-diff');
      if (diffBtn) diffBtn.onclick = () => this._openDifficultyWheel();
      // 干员开关筛网（女性向适配）：主城直达入口，与 出门探索/标本室 同级大按钮
      const custBtn = this.win.document.getElementById('home-custom');
      if (custBtn) custBtn.onclick = () => this._openCustomPanel();
    },

    /**
     * 主城「打开过场」：正中间浮现「集批的非线性存在」，同时用**旧主城背景图**整屏铺底，
     * 两者一起打个照面（1.9s）再一起淡出移除 —— 旧背景自此退位成过场，常驻背景换成 HOME_BG_URL。
     * 纯装饰、pointer-events:none 不占交互、不给界面添任何旁白文案。
     * `HOME_SPLASH_BG` 置空则只播标题（旧行为），不报错。
     */
    _playHomeSplash() {
      try {
        const doc = this.win.document;
        if (!doc) return;
        /** 建的节点统一在 2100ms 后摘掉（与 CSS 动画 1.9s 对齐，保证淡出完整且不留残留）。 */
        const autoRemove = (el) => setTimeout(() => {
          try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
        }, 2100);

        // ① 铺底：旧主城背景图（z-index 490，压在一切主城 UI 之上、标题之下）
        const oldBg = doc.getElementById('home-splash');
        if (oldBg && oldBg.parentNode) oldBg.parentNode.removeChild(oldBg);
        if (HOME_SPLASH_BG) {
          const bgEl = doc.createElement('div');
          bgEl.id = 'home-splash';
          bgEl.className = 'home-splash';
          bgEl.style.backgroundImage = 'url("' + HOME_SPLASH_BG + '")';
          doc.body.appendChild(bgEl);
          autoRemove(bgEl);
        }

        // ② 标题文字（沿用原有样式与动画）
        const old = doc.getElementById('title-splash');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        const el = doc.createElement('div');
        el.id = 'title-splash';
        el.className = 'title-splash';
        el.textContent = '集批的非线性存在';
        doc.body.appendChild(el);
        autoRemove(el);
      } catch (e) {}
    },





    /**
     * 分队 · 横向大字选牌界面（仅「后勤分队」已实现；其余显示"敬请期待"，不可点选）。
     * 选中的分队先暂存在 State.pendingSquad，点「确认编队」才进入编队界面（二次确认），
     * 真正落变量在「确认并出发」时（_applyRunDifficulty）。
     */
    renderSquadSelect(container) {
      const v = readVars(this.win);
      const saved = (v['$难度'] || {}).分队 || '后勤分队';
      let pick = State.pendingSquad || (SQUADS.some((s) => s.key === saved && s.enabled) ? saved : '后勤分队');

      const paint = () => {
        container.querySelectorAll('.sq-card').forEach((el) => {
          const it = SQUADS.find((s) => s.key === el.dataset.k) || {};
          el.classList.toggle('selected', !!it.enabled && it.key === pick);
        });
        const tip = container.querySelector('#sq-tip');
        const sel = SQUADS.find((s) => s.key === pick);
        if (tip) {
          tip.innerHTML = sel && sel.enabled
            ? '<b>' + this._escapeHtml(sel.名) + '</b>　' + this._escapeHtml(sel.描述)
            : '';
        }
      };

      const cards = SQUADS.map((s) => {
        const cls = 'sq-card' + (s.enabled ? '' : ' locked') + (s.enabled && s.key === pick ? ' selected' : '');
        return '<div class="' + cls + '" data-k="' + this._escapeHtml(s.key) + '">'
          + '<div class="sq-icon">' + squadIconSVG(s.图标, 72) + '</div>'
          + '<div class="sq-name">' + this._escapeHtml(s.名) + '</div>'
          + '<div class="sq-tag">' + this._escapeHtml(s.enabled ? s.标语 : '敬请期待') + '</div>'
          + '<div class="sq-desc">' + this._escapeHtml(s.enabled ? s.描述 : '此分队尚未开放。') + '</div>'
          + (s.enabled ? '' : '<div class="sq-lock">敬请期待</div>')
          + '</div>';
      }).join('');

      container.innerHTML = '<div class="sq-view">'
        + '<div class="sq-title">选择分队</div>'
        + '<div class="sq-scroll" id="sq-scroll">' + cards + '</div>'
        + '</div>'
        // 说明 + 按钮 = 右下角操作列（fixed，贴屏幕底、嵌进聊天面板让出的那条竖列）：
        // 说明放在「确认编队」上方，页面主体（标题 + 选牌行）则吃满整屏高度。
        + '<div class="sq-btns">'
        + '<div class="sq-tip" id="sq-tip"></div>'
        + '<button class="big-btn btn-gray" id="sq-back">← 返回</button>'
        + '<button class="big-btn btn-gold" id="sq-next">确认编队</button>'
        + '</div>';

      container.querySelectorAll('.sq-card').forEach((el) => {
        const it = SQUADS.find((s) => s.key === el.dataset.k) || {};
        if (!it.enabled) return;
        el.onclick = () => { pick = it.key; paint(); };
      });
      const back = container.querySelector('#sq-back');
      if (back) back.onclick = () => this.switchView('out_of_game');
      const next = container.querySelector('#sq-next');
      if (next) next.onclick = () => {
        const it = SQUADS.find((s) => s.key === pick);
        if (!it || !it.enabled) { this.win.alert('该分队尚未开放，请选择「后勤分队」。'); return; }
        State.pendingSquad = pick;
        // 二次确认 → 进入已落实的编队界面
        State.prepStep = 'roster';
        this.switchView('preparation');
      };
      paint();
    },

    renderPrep(container) {
      const v = readVars(this.win);
      // ── 标本库挑选：按「时间线」分组，不再把全库干员平铺成一整片 ──
      //   老做法丢掉了分世界线信息，而且干员越多页面越高（"确认并出发"被顶出屏幕）。
      //   现在：一行横向滚动的**时间线名字**（默认露出几个，其余滑动翻出）→ 点一个名字才在
      //   下方展开它里面的干员（同时只展开一条）。名字优先用玩家在标本室起的自定义名
      //   （`$时间线名称`，这里**只读**显示，不写任何变量，后端保存口径完全不变）。
      const lines = this._prepSpecLines(v);
      let openTl = String(State.prepSpecTl || '');
      const firstClear = !!(v._全局资产 && v._全局资产.首次通关标记);
      const canRandom = !firstClear;
      const poolNames = [...new Set([...Object.keys(NodePools.combat || {}), ...Object.keys(NodePools.noncombat || {})])];
      const self = this;
      let chosenKey = '';
      const paint = () => {
        const startBtn = self.win.document.getElementById('prep-start');
        const prev = self.win.document.getElementById('prep-preview');
        if (startBtn) startBtn.disabled = !chosenKey;
        // 已选中的那张卡打勾（切换时间线后仍标在它自己那一栏里）
        container.querySelectorAll('#prep-spec .op-card').forEach((c) => {
          c.classList.toggle('picked', c.dataset.k === chosenKey);
        });
        if (prev) {
          if (!chosenKey) { prev.innerHTML = ''; return; }
          prev.innerHTML = `<img src="${opAva(chosenKey)}" style="width:64px;height:64px;object-fit:contain;vertical-align:middle"> <b>${cleanName(chosenKey)}</b>`;
        }
      };
      // 只重画「时间线胶囊 + 干员格」：不动上面的随机出身与下面的按钮，chosenKey 也不会丢
      const paintSpec = () => {
        const bar = self.win.document.getElementById('prep-tl-bar');
        const body = self.win.document.getElementById('prep-spec');
        if (!bar || !body) return;
        if (!lines.length) {
          bar.innerHTML = '';
          body.innerHTML = '<div class="node-ui-empty">标本库空空如也。通关结算时，活化阶段的干员们会自己走进来。</div>';
          return;
        }
        if (!lines.some((l) => l.id === openTl)) openTl = lines[0].id;   // 上次那条没了 → 退回第一条
        State.prepSpecTl = openTl;
        bar.innerHTML = lines.map((l) => '<button type="button" class="prep-tl'
          + (l.id === openTl ? ' on' : '') + (l.anomaly ? ' anomaly' : '')
          + '" data-tl="' + self._escapeHtml(l.id) + '" title="'
          + self._escapeHtml('#' + l.id + (l.name ? ' ' + l.name : '') + ' · ' + l.count + ' 名干员') + '">'
          + '<span class="ptl-nm">' + self._escapeHtml(l.name || ('#' + l.id)) + '</span>'
          + '<span class="ptl-n">' + l.count + '人</span>'
          + '</button>').join('');
        const keys = specKeysIn(readVars(self.win), openTl);
        body.innerHTML = keys.length
          ? keys.map((k) => '<div class="op-card' + (k === chosenKey ? ' picked' : '') + '" data-k="' + self._escapeHtml(k) + '">'
            + '<img src="' + opAva(k) + '"><span>' + self._escapeHtml(cleanName(k)) + '</span></div>').join('')
          : '<div class="node-ui-empty">这条时间线下还没有归档干员。</div>';
        bar.querySelectorAll('.prep-tl').forEach((chip) => {
          chip.onclick = () => { openTl = chip.dataset.tl; paintSpec(); };
        });
        body.querySelectorAll('.op-card').forEach((card) => {
          card.onclick = () => { chosenKey = card.dataset.k; self._syncBaseCard(chosenKey); paint(); };
        });
      };
      container.innerHTML = `
        <div class="view-panel" style="min-width:540px;text-align:left">
          <h2 style="text-align:center">编队 · 基底干员</h2>
          <p style="color:#cfd8e3;font-size: max(11px, calc(13px + var(--fs-d, 0px)));line-height:1.7">选一位与你同行的基底——她身上的污染，将贯穿这次探索。</p>
          ${canRandom ? `
          <div class="sec-title">🎲 随机出身</div>
          <div class="row" style="justify-content:flex-start">
            <button class="dev-btn" id="prep-random" style="padding:10px 16px">抽一名干员</button>
            <span id="prep-preview" style="align-self:center"></span>
          </div>` : ''}
          <div class="sec-title">🫙 从标本库挑选 <span class="prep-tl-hint">（点时间线名字，展开她那条线上的干员）</span></div>
          <div class="prep-tl-bar" id="prep-tl-bar"></div>
          <div class="op-grid prep-tl-body" id="prep-spec" style="margin-top:2px"></div>
          <div class="row">
            <button class="big-btn btn-gray" id="prep-back">← 返回</button>
            <button class="big-btn btn-gold" id="prep-start" disabled>确认并出发</button>
          </div>
        </div>`;
      const rnd = this.win.document.getElementById('prep-random');
      if (rnd) rnd.onclick = () => {
        const enabled = filterNames(poolNames); // 开关筛网：滤掉开关表禁用的名字（下限保底，不会空）
        chosenKey = enabled.length ? enabled[Math.floor(Math.random() * enabled.length)] : (poolNames.length ? poolNames[Math.floor(Math.random() * poolNames.length)] : '阿米娅');
        this._syncBaseCard(chosenKey); // 实时把真实数值写入变量
        paint();
      };
      const back = this.win.document.getElementById('prep-back');
      if (back) back.onclick = () => { State.prepStep = 'squad'; this.switchView('preparation'); };
      const start = this.win.document.getElementById('prep-start');
      if (start) start.onclick = () => {
        if (!chosenKey) { this.win.alert('请先选定一名基底干员。'); return; }
        const key = chosenKey;
        writeVars(this.win, (d) => {
          // 【开新局总闸】防御性整体复位：把上一局残留（干员编队/地图/节点切片/收藏品/行动/长期池/基底/经济）
          // 全部清掉再写入本局内容 —— 无论上一局是通过哪种方式结束的，第二把都从干净状态开始，
          // 不会"进度停留在末尾 boss 节点"或把旧干员带进新局。
          this._resetRunScopedDraft(d);
          if (!d['干员编队']) d['干员编队'] = {};
          let op = d['干员编队'][key];
          if (!op) op = d['干员编队'][key] = makeEmptyOperator('开局之缘');
          // 若该角色尚无数值（例如未点选仅自动默认），按池内预设补真实值；有则保留（不覆盖 AI/已建档数据）
          const pp = POOL_BY_NAME[cleanName(key)];
          if (pp && (op.污染 == null || op.去量化 == null)) {
            op.去量化 = pp.quant;
            op.量化 = 0;
            op.痴愚 = 0;
            op.污染 = { 未来: pp.rev[0], 过往: pp.rev[1], 现实: pp.rev[2] };
          }
          op.已晋升 = op.已晋升 || false;
          if (!d['_探索进程']) d['_探索进程'] = {};
          d['_探索进程'].$基底干员 = key;
          d['_探索进程'].$当前状态 = 'map_navigation';
          d['_探索进程'].$当前层数 = 1;
          d['_探索进程'].$当前位置 = '第1列';
        });
        // 点击开始游戏 → 应用难度/分队修正并写入变量保存（纯前端叠加）
        //   ⚠ 顺序铁律：上面刚跑过 _resetRunScopedDraft()（经济已复位成 10/0/0/0），
        //     再由 _applyRunDifficulty() 加一份 delta —— 这就是"经济 = 初始值 + 一份修正"的唯一实现路径。
        // ⚠ 开局不发任何战报给 AI：等玩家进入第一个节点时由 _enterNode 统一触发（难度是纯前端效果，AI 无需知道）。
        this._applyRunDifficulty();
        State.prepStep = 'squad';
        State.currentLayer = 1;
        State.mapCache = null;
        State.currentNodeData = null;   // 新局清空节点残留（旧 boss 节点绝不延续）
        State.nodeType = '';
        State.pendingLeaveNote = '';
        State.entryRoster = null;
        State.gameOpened = true;
        State.firstNodePending = true;  // 新开局：首个节点战报附两条一次性指令 ——
        //   ① 新手建档（仅在标本库为空时）；② 开局修正（把开局前与普瑞赛斯谈定的世界线设定落进变量）。
        //   两者都吃这一道门：进首节点时各用一次，随即复位（见 _enterNode）。
        this.refreshStats();
        this.switchView('map_navigation');
      };
      paintSpec();     // 先画时间线胶囊 + 当前那条线的干员格，再由 paint() 标出已选中的卡
      paint();
    },

    /**
     * 【干员开关】全屏面板（开关表 jczl_custom_switch · 女性向适配入口）。
     *  · 名单 100% 派生自 PoolDB（层 1~5 的 作战∪非作战∪boss，不含 hiddenBoss）；
     *    创意工坊的自定义干员合入 PoolDB 后自动进名单（行尾带「工坊」标记，防和内置混淆）；
     *  · 开关即时写【角色卡变量】—— 同一张角色卡的任意聊天通用（新开聊天也沿用），换卡才是另一份；
     *  · 单独禁用受「逐池下限」拒绝保护（作战/非作战 5、boss 2）；
     *  · 一键动作（全关/只留女/只留男）先应用后逐池补足，并回报恢复名单；
     *  · 「⟳ 刷新名单」= 从 PoolDB 重新生成名单（保留既有开关，新增名补 true、消失名删除）。
     */
    _openCustomPanel() {
      const doc = this.win.document;
      const old = doc.getElementById('custom-overlay');
      if (old) old.remove();
      const overlay = doc.createElement('div');
      overlay.id = 'custom-overlay';
      overlay.className = 'custom-overlay';
      this.body.classList.add('custom-open');   // 藏掉 #chat-expand（否则它会悬在面板中间，见 CSS 注释）

      const statusEl = () => doc.getElementById('custom-status');
      const flash = (txt, bad) => {
        const el = statusEl();
        if (!el) return;
        el.innerHTML = txt;
        el.className = 'custom-status' + (bad ? ' bad' : '');
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.innerHTML = ''; }, 4200);
      };

      // 打开即重新读一次变量（外部动过角色卡变量也能看到最新；已经迁移过就不会再迁移）
      reloadSwitchTable();

      // 「工坊」标记：这些名字来自创意工坊的自定义池（jczl_custom_pool），不是内置 PoolDB。
      //   读一次就够（面板是模态的，期间改不了工坊）；工坊里 启用:false 的人压根不进名单。
      const workshopNames = new Set();
      try {
        const cp = readCustomPoolVars();
        (cp && Array.isArray(cp.chars) ? cp.chars : []).forEach((ch) => {
          if (ch && ch.启用 !== false && ch.name) workshopNames.add(String(ch.name).trim());
        });
      } catch (e) {}
      const SCOPE_LABEL = {
        character: '角色卡变量（同一张卡通用）',
        global: '全局变量（未打开角色卡时的兜底）',
        'legacy-chat': '旧聊天变量（迁移未完成，改动只影响本聊天）',
        none: '未落盘（变量不可写）',
      };
      const scopeTip = () => SCOPE_LABEL[switchScope()] || String(switchScope());

      /** 渲染列表与统计。ov 传入时按该表渲染（写后乐观更新，避免异步落盘前读到旧值）。 */
      const render = (ov) => {
        const c = ov || readSwitchTable();
        const q = ((doc.getElementById('custom-search') || {}).value || '').trim();
        const rows = CUSTOM_NAMES
          .filter((nm) => !q || nm.indexOf(q) >= 0)
          .map((nm) => {
            const on = c[nm] !== false;
            const src = workshopNames.has(nm) ? '<span class="custom-src">工坊</span>' : '';
            return '<div class="custom-row' + (on ? '' : ' off') + '">'
              + '<img class="custom-ava" src="' + opAva(nm) + '" alt="">'
              + '<div class="custom-name">' + this._escapeHtml(nm) + src
              + '<span class="custom-gender">' + this._escapeHtml(genderOf(nm)) + '</span></div>'
              + '<label class="custom-switch"><input type="checkbox" data-n="' + this._escapeHtml(nm) + '"' + (on ? ' checked' : '') + '><span class="cs-slider"></span></label>'
              + '</div>';
          })
          .join('');
        const list = doc.getElementById('custom-list');
        if (list) list.innerHTML = rows || '<div class="custom-empty">没有匹配的干员</div>';
        const onCnt = CUSTOM_NAMES.filter((nm) => c[nm] !== false).length;
        const stat = doc.getElementById('custom-stat');
        if (stat) stat.innerHTML = '已启用 ' + onCnt + ' / ' + CUSTOM_NAMES.length + ' 人（作战/非作战池保底 5 人 · boss 池保底 2 人 · 隐藏池不参与）'
          + ' · 存于 ' + this._escapeHtml(scopeTip())
          + (workshopNames.size ? ' · 其中 ' + workshopNames.size + ' 人来自创意工坊' : '');
        if (list) list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
          cb.onchange = () => {
            const nm = cb.dataset.n;
            const want = cb.checked;
            const v = wouldViolatePool(nm, want);
            if (v.violates) { cb.checked = !want; flash(this._escapeHtml(v.msg), true); return; }
            const saved = writeSwitchTable((d) => { d[nm] = want; return d; });
            render({ ...readSwitchTable(), [nm]: want });
            flash('已' + (want ? '启用' : '禁用') + '「' + this._escapeHtml(nm) + '」'
              + (saved ? '（已保存到角色卡变量）' : '（变量写入失败：本局有效，换聊天可能丢）'), !saved);
          };
        });
      };

      overlay.innerHTML =
        '<div class="custom-head">干员开关'
        + '<span class="custom-hint">禁用的干员不参与随机抽取（节点遭遇 / boss / 闲暇娱乐 / 开局随机出身）。'
        + '开关存在<b>角色卡变量</b>「jczl_custom_switch」里 —— 同一张角色卡的所有聊天通用，新开聊天也沿用；名单来自 PoolDB，改动 PoolDB 后按「刷新名单」重新生成。<br>'
        + '带<b>「工坊」</b>标记的名字来自创意工坊（另一端变量 jczl_custom_pool，只管"有哪些自定义干员、放进哪些池"）：'
        + '在工坊里取消启用＝那个人根本不进池（这里也看不到）；在本面板关掉＝人还在池里、但抽不到。两者各写各的变量，互不覆盖。'
        + '</span>'
        + '<input id="custom-search" class="custom-search" placeholder="搜索干员名…" name="jczl-search-noautofill"'
        + ' autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"'
        + ' data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other">'
        + '<div class="custom-actions">'
        + '<button class="mini-btn gold" data-a="all_on">全开</button>'
        + '<button class="mini-btn gold" data-a="all_off">全关</button>'
        + '<button class="mini-btn gold" data-a="only_f">只留女</button>'
        + '<button class="mini-btn gold" data-a="only_m">只留男</button>'
        + '<button class="mini-btn gray" data-a="refresh">⟳ 刷新名单</button>'
        + '<button class="mini-btn gray" data-a="close">关闭</button>'
        + '</div>'
        + '<div class="custom-stat" id="custom-stat"></div>'
        + '<div class="custom-status" id="custom-status"></div>'
        + '</div>'
        + '<div class="custom-list" id="custom-list"></div>';
      doc.body.appendChild(overlay);

      const search = doc.getElementById('custom-search');
      if (search) search.oninput = () => render();
      overlay.querySelectorAll('[data-a]').forEach((btn) => {
        btn.onclick = () => {
          const a = btn.dataset.a;
          if (a === 'close') { overlay.remove(); this.body.classList.remove('custom-open'); return; }
          if (a === 'refresh') {
            const r = refreshCustom();
            render(r.custom);
            flash((r.saved ? '' : '变量写入失败：') + '已按 PoolDB 重新生成名单（' + r.count + ' 人，既有开关已保留）', !r.saved);
            return;
          }
          let out;
          if (a === 'all_on') {
            const next = {};
            CUSTOM_NAMES.forEach((nm) => { next[nm] = true; });
            const saved = writeSwitchTable(() => next);
            render(next);
            flash('已全部启用' + (saved ? '（已保存到角色卡变量）' : '（变量写入失败：本局有效，换聊天可能丢）'), !saved);
            return;
          } else if (a === 'all_off') {
            out = applyBatch(() => false);
          } else if (a === 'only_f') {
            out = applyBatch((nm) => genderOf(nm) === '女');
          } else if (a === 'only_m') {
            out = applyBatch((nm) => genderOf(nm) === '男');
          } else { return; }
          render(out.custom);
          const head = out.saved ? '已执行。' : '已执行（变量写入失败：本局有效，换聊天可能丢）。';
          flash(out.restored.length
            ? head + '为守住下限自动恢复：' + this._escapeHtml(out.restored.slice(0, 8).join('、')) + (out.restored.length > 8 ? ' 等 ' + out.restored.length + ' 人' : '')
            : head);
        };
      });
      render();
    },

    /** preparation 是"分队选牌 + 编队"两步共用状态；按 State.prepStep 分发渲染 */
    _renderPreparation(main) {
      // ⚠ 「基底干员」这一步才用可拖曳大画布（body.in-prep）；
      //   「选择分队」那一步**保持改动前的排版**（作者口径：那页套大画布会乱，别动它）。
      const roster = State.prepStep !== 'squad';
      this.body.classList.toggle('in-prep', roster);
      if (roster) {
        // 编队两步页 = 可拖曳的大画布（见全局样式 body.in-prep）：绑定一次，之后只切 body 类
        try { this._bindPrepPan(); } catch (e) {}
        // 每次进这一页都把画布归位到左上角（上一步拖到哪不该带进来）
        try { if (main) { main.scrollTop = 0; main.scrollLeft = 0; } } catch (e) {}
        State.prepStep = 'roster';
        this.renderPrep(main);
        return;
      }
      this.renderSquadSelect(main);
    },

    /**
     * 编队页「从标本库挑选」用的时间线清单：**只列有干员的时间线**，带玩家自定义名。
     *   · 名字优先用 `$时间线名称`（玩家在标本室起的名字）—— 这里**只读**，绝不回写，
     *     所以"显示自定义名"不会影响后端保存口径；没起名就显示 `#编号`；
     *   · 顺序沿用标本室折叠树（按该线首条剧情的世界历升序，没剧情的排最后再按编号）；
     *   · 末尾补上 AI 写歪的异常组（组名不是四位编号）：以前平铺时这些干员能点到，
     *     现在给它们一张虚线胶囊，免得人凭空消失。
     * @returns {Array<{id:string,name:string,count:number,anomaly:boolean}>}
     */
    _prepSpecLines(v) {
      const out = [];
      try {
        this._timelineList().forEach((r) => {
          if (!(Number(r.ops) > 0)) return;             // 只有剧情、没有干员的线不参与挑选
          out.push({ id: r.id, name: r.name || '', count: Number(r.ops) || 0, anomaly: false });
        });
      } catch (e) {}
      try {
        specAnomalyGroups(v).forEach((g) => {
          const n = Object.keys(g.bag || {}).filter(isChronicleEntryKey).length;
          if (n > 0) out.push({ id: g.id, name: String(g.id), count: n, anomaly: true });
        });
      } catch (e) {}
      return out;
    },

    /**
     * 编队两步页的「按住拖动」：鼠标按住画面即可平移（触屏交给原生滚动，惯性更好）。
     * 为什么要它：这两页画在 #stage 里，底部会被正文窗/聊天面板压住一块，干员一多还会顶出上下边界。
     * 画布能拖 → 玩家自己就能把被挡住的那一行拖出来，不必去调窗口尺寸。
     *  · 只对 body.in-prep 生效；
     *  · 位移超过 5px 才进入拖拽态，随即 setPointerCapture 到容器上 —— 后续 click 落在容器上，
     *    不会被误当成"点了某个按钮"；另外再挂一层捕获期 click 兜底；
     *  · .sq-scroll / .prep-tl-bar 自带横向滚动，起点在它们里面时不平移画布。
     */
    _bindPrepPan() {
      const d = this.win.document;
      const el = d.getElementById('main-content');
      if (!el || el.dataset.prepPanBound) return;
      el.dataset.prepPanBound = '1';
      let down = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0, pid = null;
      const TH = 5;
      el.addEventListener('pointerdown', (e) => {
        if (!this.body.classList.contains('in-prep')) return;
        if (e.pointerType === 'touch') return;                   // 触屏走原生滚动
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('.sq-scroll, .prep-tl-bar')) return;
        down = true; moved = false; pid = e.pointerId;
        sx = e.clientX; sy = e.clientY; sl = el.scrollLeft; st = el.scrollTop;
      });
      el.addEventListener('pointermove', (e) => {
        if (!down) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.abs(dx) < TH && Math.abs(dy) < TH) return;
        if (!moved) {
          moved = true;
          el.classList.add('panning');
          try { el.setPointerCapture(pid); } catch (err) {}
        }
        el.scrollLeft = sl - dx;
        el.scrollTop = st - dy;
        e.preventDefault();
      });
      const end = () => {
        if (!down) return;
        down = false;
        el.classList.remove('panning');
        try { if (el.hasPointerCapture && el.hasPointerCapture(pid)) el.releasePointerCapture(pid); } catch (err) {}
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('pointerleave', end);
      // 拖过之后那一次 click 直接吞掉（捕获期拦截，先于任何按钮的 onclick）
      el.addEventListener('click', (e) => {
        if (!moved) return;
        moved = false;
        e.stopPropagation();
        e.preventDefault();
      }, true);
    },

    _shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      return arr;
    },

    // ============================================================================
    // 【节点确认栏】点地图节点 → 右缘滑入一整条确认栏（同步选中节点图标）
    //   · 只有作战类（作战/紧急作战/险路恶敌）带「选择主战干员」框 —— 它等价于顶栏那颗按钮，
    //     点开的是**同一个** _openBasePicker（选完两边同时生效，读写同一个 $基底干员）。
    //   · 其它节点：一句固定 INFO（取自参考图）+ 出发前往。
    //   · 再点同一节点 / 点地图空白 / 换视图 → 关闭。进入节点只由「出发前往」触发。
    //   · 紧急作战：把参考图里的紫换成红（其余照搬）。
    // ============================================================================

    /** 键的显示名：标本键（名字+四位编号）原样显示，野生键只显示名字。 */
    _nodeDisplayName(key) {
      const k = String(key || '');
      if (!k) return '';
      return isSpecimenKey(k) ? k : cleanName(k);
    },

    /** 当前主战干员（$基底干员）的键；没有 → ''。 */
    _baseOperatorKey() {
      try {
        const v = readVars(this.win);
        return String((v._探索进程 || {}).$基底干员 || '');
      } catch (e) { return ''; }
    },

    /** 打开确认栏（同一节点重复点击由调用方先判重）。配色按节点类型分（见 NODE_TYPE_ACCENT）。 */
    _openNodeConfirm(type, colIdx, nodeIdx) {
      this._closeNodeConfirm(true);
      const doc = this.win.document;
      const el = doc.createElement('div');
      el.id = 'node-confirm';
      el.className = nodeAccentClass(type);      // 作战紫 / 紧急作战红 / 安全屋蓝 / 不期而遇青 / 闲暇娱乐青绿 / 诡意行商绿
      el.innerHTML = this._nodeConfirmHTML(type);
      doc.body.appendChild(el);
      State.nodeConfirm = { key: type + '|' + colIdx + '|' + nodeIdx, type: type, col: colIdx, idx: nodeIdx };
      const go = el.querySelector('#nc-go');
      if (go) go.onclick = (e) => { e.stopPropagation(); this._confirmEnterNode(); };
      const bx = el.querySelector('#nc-base');
      if (bx) bx.onclick = (e) => { e.stopPropagation(); try { this._openBasePicker(); } catch (err) {} };
    },

    /** 关闭确认栏（instant=true 立刻移除，不做淡出）；同时清掉地图节点的选中态。 */
    _closeNodeConfirm(instant) {
      State.nodeConfirm = null;
      try {
        const doc = this.win.document;
        const el = doc.getElementById('node-confirm');
        if (el) {
          if (instant) el.remove();
          else {
            el.classList.add('out');
            setTimeout(() => { try { el.remove(); } catch (e) {} }, 180);
          }
        }
        doc.querySelectorAll('.map-node.selected').forEach((n) => n.classList.remove('selected'));
      } catch (e) {}
    },

    /** 主战干员框的内容（头像 + 名字）；改完主战干员后用它原地刷新，不必重建整栏。 */
    _nodeBaseBoxHTML() {
      const key = this._baseOperatorKey();
      const nm = this._nodeDisplayName(key);
      const ava = key
        ? '<img src="' + opAva(key) + '" alt="">'
        : '<span style="display:block;width:100%;height:100%;background:rgba(255,255,255,.05)"></span>';
      return '<div class="nc-base" id="nc-base" title="选择主战干员（与顶栏按钮共通）">'
        + '<span class="nc-base-ava">' + ava + '</span>'
        + '<span class="nc-base-txt"><span class="nc-base-cap">主战干员</span>'
        + '<span class="nc-base-nm' + (nm ? '' : ' empty') + '">' + this._esc(nm || '未选择 · 点此选择') + '</span></span>'
        + '<span class="nc-base-arrow">▸</span></div>';
    },

    /** 确认栏整块 HTML。标题不再配节点图标，只有一条渐变色条（颜色由 #node-confirm 的 class 决定）。 */
    _nodeConfirmHTML(type) {
      const t = String(type || '');
      const combat = isCombatNodeType(t);
      const en = NODE_TYPE_EN[t] || '';
      const info = NODE_INFO_TEXT[t] || '';
      return '<div class="nc-head">'
        + '<span class="nc-band"></span>'
        + '<span class="nc-title">' + this._esc(t) + (en ? '<i>' + en + '</i>' : '') + '</span>'
        + '</div>'
        + (combat ? this._nodeBaseBoxHTML()
          : (info ? '<div class="nc-info"><span class="nc-info-tag">INFO</span><span>' + this._esc(info) + '</span></div>' : ''))
        + '<span class="nc-spacer"></span>'
        + '<button class="nc-go" id="nc-go" type="button">出发前往<i>READY TO</i></button>';
    },

    /** 主战干员变了 → 若确认栏正开着就原地刷新框内头像与名字。 */
    _refreshNodeConfirmBase() {
      try {
        const el = this.win.document.getElementById('node-confirm');
        if (!el) return;
        const old = el.querySelector('#nc-base');
        if (!old) return;
        const wrap = this.win.document.createElement('div');
        wrap.innerHTML = this._nodeBaseBoxHTML();
        const fresh = wrap.firstElementChild;
        if (!fresh) return;
        old.parentNode.replaceChild(fresh, old);
        fresh.onclick = (e) => { e.stopPropagation(); try { this._openBasePicker(); } catch (err) {} };
      } catch (e) {}
    },

    /** 「出发前往」：关栏 → 进节点（作战类会先起伪加载页，见 _enterNode）。 */
    _confirmEnterNode() {
      const c = State.nodeConfirm;
      if (!c) return;
      if (State.failed) { this._closeNodeConfirm(true); return; }
      if (State.busyPhase === 'generating') {
        // AI 还在跑：不进节点，但**别把玩家的点击吞掉**——给一句提示，栏继续留着
        this._uiAlert('正在生成，等这一段写完再出发。', '出发前往');
        return;
      }
      const type = c.type, col = c.col, idx = c.idx;
      this._closeNodeConfirm(true);
      this._enterNode(type, col, idx);
    },

    // ============================================================================
    // 【作战伪加载页】仅作战类：点「出发前往」后盖住全屏 ≈5.5s
    //   关键时序：**战报在 _enterNode 里已经发出去了**（AI 正在跑），加载页只是表现层；
    //   加载期间冻结战报卡 / 日志播报，结束后由 _flushDeferredPresentation 补播。
    // ============================================================================

    /** 本节点 loading 页上的关卡名：狮蝎/菈玛莲 特例优先，其次按节点类型从池里随机。 */
    _loadingLevelName(type, encounterName) {
      const nm = String(encounterName || '').trim();
      if (nm && LOADING_LEVEL_SPECIAL[nm]) return LOADING_LEVEL_SPECIAL[nm];
      const pool = (type === '险路恶敌') ? LOADING_LEVELS_EX : LOADING_LEVELS_SP;
      return pool[Math.floor(Math.random() * pool.length)] || '';
    },

    /**
     * 起伪加载页。
     * @param {string} type 节点类型（决定 LSW-SP / LSW-EX）
     * @param {string} encounterName 本节点遭遇名（狮蝎/菈玛莲 走特例关卡名）
     */
    _startNodeLoading(type, encounterName) {
      try {
        const doc = this.win.document;
        const old = doc.getElementById('node-loading');
        if (old) old.remove();
        const code = (type === '险路恶敌') ? LOADING_CODE_EX : LOADING_CODE_SP;
        const lv = this._loadingLevelName(type, encounterName);
        const tip = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)] || '';
        const el = doc.createElement('div');
        el.id = 'node-loading';
        el.innerHTML = '<div class="nld-bg nld-bg1" style="background-image:url(&quot;' + NODE_UI_ASSETS.loading + '&quot;)"></div>'
          + '<div class="nld-bg nld-bg2" style="background-image:url(&quot;' + NODE_UI_ASSETS.loading2 + '&quot;)"></div>'
          + '<div class="nld-lines">'
          + '<div class="nld-op">OPERATION</div>'
          + '<div class="nld-code">' + this._esc(code) + '</div>'
          + '<div class="nld-name">' + this._esc(lv) + '</div>'
          + '<div class="nld-tip">' + this._esc(tip) + '</div>'
          + '<div class="nld-load">Loading.</div>'
          + '</div>';
        doc.body.appendChild(el);
        State.loadingActive = true;
        State.pendingStack = false;
        State.pendingMissionDone = false;
        // 右下角 Loading 的点：一个 → 两个 → 三个 → 一个 …（每 400ms 一档）
        const dotEl = el.querySelector('.nld-load');
        let dots = 1;
        const dotTimer = setInterval(() => {
          dots = (dots % 3) + 1;
          if (dotEl) dotEl.textContent = 'Loading' + '.'.repeat(dots);
        }, 400);
        State.loadingTimers = [dotTimer];
        const bg2 = el.querySelector('.nld-bg2');
        // ① 图1 停 firstMs → 交叉淡入图2（文字不变，只有底图换）
        State.loadingTimers.push(setTimeout(() => { if (bg2) bg2.style.opacity = '1'; }, LOADING_TIMING.firstMs));
        // ② 图2 再停 secondMs → 整页淡出 → 移除并放行被压住的动画
        State.loadingTimers.push(setTimeout(() => {
          el.classList.add('out');
          State.loadingTimers.push(setTimeout(() => {
            try { el.remove(); } catch (e) {}
            while (State.loadingTimers.length) { try { clearTimeout(State.loadingTimers.pop()); } catch (e) {} }
            State.loadingActive = false;
            this._flushDeferredPresentation();
          }, LOADING_TIMING.fadeMs));
        }, LOADING_TIMING.firstMs + LOADING_TIMING.secondMs));
      } catch (e) {
        // 任何异常都不能挡住进节点：直接放行
        State.loadingActive = false;
        try { this._flushDeferredPresentation(); } catch (err) {}
      }
    },

    /** 加载页结束后补播被压住的动画（任务完成条 → 节点数值战报卡 → 日志播报队列）。 */
    _flushDeferredPresentation() {
      if (State.loadingActive) return;
      if (State.pendingMissionDone) {
        State.pendingMissionDone = false;
        try { this._playMissionDoneOnce(); } catch (e) {}
      }
      if (State.pendingStack) {
        State.pendingStack = false;
        try { this._showNodeStackOverlay(); } catch (e) {}
      }
      try {
        if (!State.chroniclePlaying && (State.chronicleQueue || []).length) this._playChronicleQueue();
      } catch (e) {}
    },

    // ============================================================================
    // 【任务完成条】作战类节点「可以离开了」的那一刻播一次
    //   触发点：_ensureLeaveCard 第一次把「离开节点」卡挂上去（= 从不可离开 → 可离开）。
    //   每节点只播一次（State.missionDoneKey）；加载页期间来的请求排队到加载结束再播。
    // ============================================================================
    _playMissionDoneOnce() {
      try {
        if (!isCombatNodeType(State.nodeType || '')) return;
        const ni = readVars(this.win)['$切片'] || {};
        const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : {};
        const key = String(nd.节点编号 || '') + '|' + String(nd.type || '');
        if (State.missionDoneKey === key) return;          // 本节点已播过
        if (State.loadingActive) { State.pendingMissionDone = true; return; }
        State.missionDoneKey = key;
        this._playMissionDone();
      } catch (e) {}
    },

    /** 黑条动画本体：整体左右平移（文字/标记都在同一个容器里，不会错位）。 */
    _playMissionDone() {
      try {
        const doc = this.win.document;
        const old = doc.getElementById('mission-done');
        if (old) old.remove();
        const el = doc.createElement('div');
        el.id = 'mission-done';
        el.innerHTML = '<div class="md-mark"><div class="md-tri"></div>'
          + '<img class="md-logo" src="' + NODE_UI_ASSETS.logo + '" alt=""></div>'
          + '<div class="md-txt"><span class="md-cn">任务完成</span>'
          + '<span class="md-en">MISSION ACCOMPLISHED</span>'
          + '<span class="md-sub">RHODES ISLAND</span></div>';
        doc.body.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch (e) {} }, 2400);
      } catch (e) {}
    },

    renderMap(container) {
      // 读取/初始化地图状态。优先用本局会话缓存（State.mapCache），
      // 避免变量持久化时序问题导致"离开节点后地图重新生成、进度丢失"。
      let mapState = State.mapCache;
      // 缓存失效（跨层）→ 回读变量
      if (!mapState || mapState.层数 !== State.currentLayer) {
        try {
          const v = readVars(this.win);
          mapState = v['$地图状态'];
        } catch (e) { mapState = null; }
      }
      // 变量也失效/不匹配 → 重新生成这一层
      if (!mapState || mapState.层数 !== State.currentLayer || !Array.isArray(mapState.每列) || !mapState.每列.length) {
        mapState = this._genMap();
        mapState.层数 = State.currentLayer;
        if (!mapState.解锁列数) mapState.解锁列数 = 1;
        if (mapState.当前列 == null) mapState.当前列 = 0;
      }
      // 记录为本局缓存（保持解锁进度）
      State.mapCache = mapState;
      this._persistMap(mapState); // 同步持久化，供重启恢复
      // 本层真实级数（4 或 5）—— 显示与解锁夹紧都以它为准，不再写死 5
      const totalCols = (Array.isArray(mapState.每列) && mapState.每列.length) ? mapState.每列.length : this._layerCols(State.currentLayer);
      // ☆ 解锁级数夹紧到 [1, totalCols]：换层后级数变化、或旧存档残留越界值时，
      //   若不夹紧会出现 activeCol 越界 → 全图没有任何一级可点 → 卡死且不触发换层。
      const unlocked = Math.max(1, Math.min(Number(mapState.解锁列数) || 1, totalCols));
      if (Number(mapState.解锁列数) !== unlocked) mapState.解锁列数 = unlocked;
      // ☆ 以「解锁列数」为准推导当前进行列：最新已解锁的那一列 = 当前可进行列，
      //   更靠前的列即「已通过」→ 变暗锁定；更靠后的列即「未解锁」→ 灰度锁定。
      //   （不再依赖可能不被推进的 mapState.当前列，保证通关后过往节点能正确变暗。）
      const activeCol = unlocked - 1;

      // 重绘地图 = 地图上的选择态归零，旧的确认栏也一并撤掉（避免指向已失效的节点）
      this._closeNodeConfirm(true);

      // ---- 节点容器（弹性 flex 布局：内容不缩放，容器自适应横滚） ----
      let html = '<div class="map-scroll"><div class="map-inner">';
      mapState.每列.forEach((col, ci) => {
        const isPassed = ci < activeCol;       // 已通过列（过往）→ 变暗锁定
        const isUnlocked = ci >= unlocked;     // 未解锁列 → 灰度锁定
        const canClick = ci === activeCol;     // 仅当前进行列可点
        html += `<div class="map-col">`;
        col.forEach((node, j) => {
          const cls = isUnlocked ? 'locked' : (isPassed ? 'passed' : '');
          html += `<div class="map-node ${cls}" data-type="${node.type}" data-col="${ci}" data-idx="${j}">
            <img src="${this._nodeIconUrl(node.type)}" title="${node.type}" ${canClick ? '' : 'aria-locked="1"'} />
          </div>`;
        });
        html += '</div>';
      });
      // 覆盖全图的高层箭头图层（空，随后用真实节点坐标填充）
      html += '<svg class="map-links" id="map-links"></svg>';
      html += '</div></div>';
      container.innerHTML = html;

      // 布局完成后读取真实节点位置绘制弧线箭头（任意尺寸/缩放自适应）
      this._drawMapLinks(mapState);
      // 注册鼠标/触摸拖拽平移（左右 + 小幅上下），保证小屏也能滑动看清全部节点
      this._bindMapPan(container);
      // ▶ 窗口尺寸/方向变化（含媒体断点切换、手机横竖屏）→ 节点布局变了，
      //   箭头坐标必须重绘，否则缩放后箭头错位（旧 bug）。拖拽滚动不重绘（SVG 随容器同步滚动）。 */
      this._bindMapResize();

      // 单击选择（仅当前可点列节点可点；互斥）：
      //   第一次点 = 选中 + 右缘弹出确认栏；再点**同一个**节点 = 关闭确认栏（不再"两次点击直接进入"）。
      //   真正进节点只由确认栏里的「出发前往」触发（见 _confirmEnterNode）。
      const nodes = container.querySelectorAll('.map-node');
      nodes.forEach((nd) => {
        if (nd.classList.contains('locked') || nd.classList.contains('passed')) { nd.style.cursor = 'not-allowed'; return; }
        nd.onclick = (e) => {
          if (e && e.stopPropagation) e.stopPropagation();
          const col = parseInt(nd.dataset.col, 10);
          const idx = parseInt(nd.dataset.idx, 10);
          const key = nd.dataset.type + '|' + col + '|' + idx;
          const same = !!(State.nodeConfirm && State.nodeConfirm.key === key);
          nodes.forEach((x) => x.classList.remove('selected'));
          if (same) { this._closeNodeConfirm(); return; }
          nd.classList.add('selected');
          this._openNodeConfirm(nd.dataset.type, col, idx);
        };
      });
      // 点地图空白处 = 关闭确认栏（拖拽平移之后的那一次 click 不算点击）
      container.onclick = (e) => {
        if (e.target && e.target.closest && e.target.closest('.map-node')) return;
        const sc = container.querySelector('.map-scroll');
        if (sc && sc.__dragged) { sc.__dragged = false; return; }
        this._closeNodeConfirm();
      };
    },

    /**
     * 根据节点真实布局坐标绘制列间弧线箭头。
     * 完全基于 DOM 实际位置（getBoundingClientRect），因此任何窗口/字号/滚动下都准确对齐，不缩放、不位移。
     */
    _drawMapLinks(mapState) {
      const inner = this.win.document.querySelector('.map-inner');
      const svg = this.win.document.getElementById('map-links');
      if (!inner || !svg) return;
      const iRect = inner.getBoundingClientRect();
      const iw = inner.scrollWidth || inner.offsetWidth;
      const ih = inner.scrollHeight || inner.offsetHeight;
      const colEls = inner.querySelectorAll('.map-col');
      const colN = mapState.每列.map((c) => c.length);

      let paths = '';
      for (let pi = 0; pi < mapState.每列.length - 1; pi++) {
        const ni = pi + 1;
        const map = this._computeConnections(colN[pi], colN[ni]);
        for (let a = 0; a < colN[pi]; a++) {
          (map[a] || []).forEach((b) => {
            const nodeA = colEls[pi].children[a];
            const nodeB = colEls[ni].children[b];
            if (!nodeA || !nodeB) return;
            const rA = nodeA.getBoundingClientRect();
            const rB = nodeB.getBoundingClientRect();
            // 箭头起于本列节点右缘、止于下列节点左缘（落在两节点空隙中）
            const x1 = rA.right - iRect.left, y1 = rA.top - iRect.top + rA.height / 2;
            const x2 = rB.left - iRect.left, y2 = rB.top - iRect.top + rB.height / 2;
            const dx = x2 - x1;
            const ctrlY = (y1 + y2) / 2; // S 形平滑弧
            paths += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx * 0.5).toFixed(1)} ${ctrlY.toFixed(1)}, ${(x2 - dx * 0.5).toFixed(1)} ${ctrlY.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}"
              fill="none" stroke="rgba(180,190,205,0.55)" stroke-width="2.5"
              stroke-linecap="round" marker-end="url(#mapArrow)"/>`;
          });
        }
      }
      svg.setAttribute('width', iw);
      svg.setAttribute('height', ih);
      svg.setAttribute('viewBox', `0 0 ${iw} ${ih}`);
      svg.innerHTML =
        `<defs>
          <marker id="mapArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(180,190,205,0.55)"/>
          </marker>
        </defs>` + paths;
    },

    /**
     * 地图拖拽平移（左右 + 小幅上下）。
     * - 用 Pointer Events（兼容鼠标 / 触摸 / 触控笔）。
     * - 拖动空白/背景区（非节点）时，同步更新容器 scrollLeft / scrollTop。
     * - 点击节点选择不受影响（节点上不启动平移）。
     * - 四周留白已在 CSS 中用 padding 保证，任何方向都能拖到尽头露出全部节点。
     * 每次渲染地图后应调用一次（重渲染会重建 DOM，需重新绑定）。
     */
    _bindMapPan(container) {
      const scroll = container.querySelector('.map-scroll');
      if (!scroll) return;
      const doc = this.win.document;
      let startX = 0, startY = 0;
      let startScrollLeft = 0, startScrollTop = 0;
      let dragging = false;
      let moved = false;

      scroll.addEventListener('pointerdown', (e) => {
        // 点中节点 → 交由节点选择逻辑，不启动平移
        if (e.target.closest('.map-node')) return;
        dragging = true;
        moved = false;
        startX = e.clientX; startY = e.clientY;
        startScrollLeft = scroll.scrollLeft;
        startScrollTop = scroll.scrollTop;
        try { scroll.setPointerCapture(e.pointerId); } catch (err) {}
        scroll.classList.add('panning');
        e.preventDefault();
      });

      scroll.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // 轻微晃动不算拖动
        moved = true;
        scroll.scrollLeft = startScrollLeft - dx;
        scroll.scrollTop  = startScrollTop  - dy;
        e.preventDefault();
      });

      const endDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        // 真正拖动过 → 标记一下，让随后的 click 不去关确认栏（见 renderMap 的空白点击）
        scroll.__dragged = moved;
        try { if (scroll.hasPointerCapture && scroll.hasPointerCapture(e.pointerId)) scroll.releasePointerCapture(e.pointerId); } catch (err) {}
        scroll.classList.remove('panning');
      };
      scroll.addEventListener('pointerup', endDrag);
      scroll.addEventListener('pointercancel', endDrag);
      // 移出容器仍结束拖拽，避免卡住
      scroll.addEventListener('pointerleave', (e) => { if (dragging) endDrag(e); });
      void doc;
    },

    /**
     * ▶ 窗口 resize / 手机横竖屏切换 → 重绘地图箭头。
     * 媒体断点（900/640/400px）会缩放节点与列间距，但那是纯 CSS 变化、不触发重绘，
     * 箭头坐标是渲染时按旧布局算的 → 必错位。这里监听并用最新布局重算一次。
     * 监听只注册一次（带 _mapResizeBound 标记，map DOM 重建不叠加监听）。
     */
    _bindMapResize() {
      if (this._mapResizeBound) return;
      this._mapResizeBound = true;
      const redraw = () => {
        if (State.currentStatus !== 'map_navigation') return;
        if (!State.mapCache) return;
        try { this._drawMapLinks(State.mapCache); } catch (e) {}
      };
      const win = this.win || window;
      if (win.addEventListener) {
        win.addEventListener('resize', redraw);
        win.addEventListener('orientationchange', redraw);
      }
    },

    /** 生成第 2/4 列随机障碍（黑格）。约束：最多 2 格紧挨（防三联）、贴边必单独。返回 cellId 数组 */

    /** 校验某列的黑格行集合是否合法 */

    /**
     * 本层地图级数（竖列数）—— 全工程唯一口径，任何地方都不得再写死 5。
     *   - 第 1 层：4 级（开局引导层，末级固定 诡意行商 收尾，且不出现 安全屋）；
     *   - 第 2~5 层：5 级；
     *   - 隐藏层（≥HIDDEN_LAYER）：固定 HIDDEN_MAP_SEQUENCE.length 级（单行线性，无随机）。
     */
    _layerCols(layer) {
      const L = Number(layer) || 1;
      if (L >= HIDDEN_LAYER) return HIDDEN_MAP_SEQUENCE.length;   // 隐藏层：固定序列长度
      return L === 1 ? 4 : 5;
    },

    /**
     * 生成一层新地图（级数由 _layerCols 决定）：
     *   - 普通层：中间各级每级 1~3 节点，类型随机；末级固定 1 个终端节点
     *     （诡意行商 / 险路恶敌 / 第2层为普通作战），由 _randomNodeType 按层规则给定。
     *   - 隐藏层：固定单行线性（每级恰 1 节点，类型走 HIDDEN_MAP_SEQUENCE），无随机形态。
     */
    _genMap() {
      const layer = State.currentLayer;
      const totalCols = this._layerCols(layer);
      const lastCol = totalCols - 1;
      const hidden = layer >= HIDDEN_LAYER;
      // 短对局补偿列：第 5 层 boss 前固定一个**单独**的诡意行商（-1 = 本层没有这一列）
      const shopCol = hidden ? -1 : this._shortBossShopCol(layer, totalCols);
      const cols = [];
      for (let i = 0; i < totalCols; i++) {
        // 隐藏层：每列固定 1 节点；普通层末级固定 1 节点、中间级随机 1~3；短对局补偿列固定 1 节点
        const n = hidden ? 1 : ((i === lastCol || i === shopCol) ? 1 : Math.min(3, 1 + Math.floor(Math.random() * 3)));
        const arr = [];
        for (let j = 0; j < n; j++) {
          const type = (i === shopCol) ? '诡意行商' : this._randomNodeType(i, layer, totalCols);
          arr.push({ type, id: `L${layer}C${i}N${j}` });
        }
        cols.push(arr);
      }
      return { 层数: layer, 每列: cols, 解锁列数: 1, 当前列: 0 };
    },

    _persistMap(mapState) {
      writeVars(this.win, (d) => { d['$地图状态'] = mapState; });
    },

    /**
     * 通关当前级后推进：未到本层末级 → 解锁下一级；已过末级 → 换层并生成新一层地图。
     *
     * ⚠ 换层判定**只认本层地图自身的级数**（mapState.每列.length），绝不写死 5：
     *   第 1 层只有 4 级（末级 诡意行商），第 2~5 层为 5 级。若按固定 5 判级数，
     *   第 1 层打完第 4 级就换不了层（卡死），或旧口径下会在错误的一级提前换层。
     *   缓存跨层残留 / 地图丢失时一律回退重建，绝不凭默认值发换层事件。
     */
    _advanceMap() {
      try {
        const layerNow = State.currentLayer;
        // 优先取内存缓存（保进度）；缓存不属于本层或不带节点 → 回读变量
        let mapState = State.mapCache || null;
        if (!mapState || !Array.isArray(mapState.每列) || !mapState.每列.length || Number(mapState.层数) !== Number(layerNow)) {
          mapState = null;
          try {
            const v = readVars(this.win);
            const fromVars = v['$地图状态'];
            if (fromVars && Array.isArray(fromVars.每列) && fromVars.每列.length && Number(fromVars.层数) === Number(layerNow)) mapState = fromVars;
          } catch (e) { mapState = null; }
        }
        if (!mapState || !Array.isArray(mapState.每列) || !mapState.每列.length) {
          // 地图真的丢了：此刻无法判断"是否已到末级"，宁可不推进也不误发换层事件；
          // 下一次 renderMap 会按本层规则重建地图（解锁级数回到 1）。
          console.warn('[集成战略] 地图状态缺失，跳过本次推进（等待 renderMap 重建）');
          return;
        }
        const totalCols = mapState.每列.length;                 // ← 本层真实级数（4 或 5），唯一依据
        const unlocked = Math.max(1, Number(mapState.解锁列数) || 1);
        if (unlocked >= totalCols) {
          // 已是末级 → 本层通关，换层（新一层级数由 _genMap 内按 State.currentLayer 决定）
          // ⚠ 层序唯一入口：正常 x→x+1，短对局 1→3→5（见 _nextLayer）。
          State.currentLayer = this._nextLayer(layerNow);
          const next = this._genMap();
          next.层数 = State.currentLayer;
          next.解锁列数 = 1;
          State.mapCache = next;
          this._persistMap(next);
        } else {
          mapState.解锁列数 = unlocked + 1;                      // 解锁下一级（保留已生成的各级节点）
          State.mapCache = mapState;
          this._persistMap(mapState);
        }
      } catch (e) {}
    },

    /**
     * 按层规则掷出一个节点类型。
     * @param {number} colIndex 本级下标（0 起）
     * @param {number} layer    当前层
     * @param {number} [totalCols] 本层级数；缺省按 _layerCols(layer) 取。
     *   末级判定一律走此参数，保证"末级"永远等于本层实际最后一列（第1层=下标3、其余层=下标4；
     *   隐藏层不经过末级判定，直接在上方固定序列分支返回）。
     */
    _randomNodeType(colIndex, layer, totalCols) {
      const total = Number(totalCols) || this._layerCols(layer);
      if (layer >= HIDDEN_LAYER) {
        // 隐藏层：不掷随机，按固定序列取本列类型（colIndex 越界兜底为 作战，正常不会发生）
        return HIDDEN_MAP_SEQUENCE[Number(colIndex)] || '作战';
      }
      if (colIndex >= total - 1) {
        // 末级节点类型按层规则：
        //   1/4 层末级 → 诡意行商；2 层末级 → 普通作战收尾；
        //   3/5 层及以后 → 险路恶敌（隐藏层已在上方固定序列分支返回，到不了这里）
        if (layer === 1 || layer === 4) return '诡意行商';
        if (layer === 3 || layer >= 5) return '险路恶敌';
        return '作战';
      }
      // 中间各级不出现 诡意行商/险路恶敌；此两种只能在末级单独出现
      const r = Math.random();
      if (layer === 1) {
        // 第 1 层是开局引导层：不出现 安全屋（该层无休整据点），四类节点按权重铺开
        if (r < 0.34) return '作战';
        if (r < 0.52) return '紧急作战';
        if (r < 0.76) return '不期而遇';
        return '闲暇娱乐';
      }
      if (r < 0.30) return '作战';
      if (r < 0.46) return '紧急作战';
      if (r < 0.62) return '不期而遇';
      if (r < 0.84) return '安全屋';
      return '闲暇娱乐';
    },

    _nodeColor(type) {
      switch (type) {
        case '作战': return '#ff4d4f';
        case '紧急作战': return '#ff7a1f';
        case '险路恶敌': return '#b04a5e';
        case '不期而遇': return '#b042ff';
        case '诡意行商': return '#ffd25c';
        case '闲暇娱乐': return '#2bb3ff';
        case '安全屋': return '#2bb86e';
        default: return '#cccccc';
      }
    },

    /** 节点类型 → 图标文件名后缀（图源 A_URL 前缀 + 后缀 + .png） */
    _nodeIconSuffix(type) {
      switch (type) {
        case '作战': return 'zz';
        case '紧急作战': return 'jjzz';
        case '险路恶敌': return 'xled';
        case '不期而遇': return 'bqey';
        case '诡意行商': return 'gyxs';
        case '闲暇娱乐': return 'xxyl';
        case '安全屋': return 'aqw';
        default: return 'zz';
      }
    },
    _nodeIconUrl(type) {
      return A_URL + this._nodeIconSuffix(type) + '.png';
    },

    /**
     * █ 节点连接规则（computeConnections）。
     * 本列(起点) → 下一列(终点) 的连接关系，按本列/下列节点数组合决定。
     * @param {number} nA 本列（左列）节点数 1~3
     * @param {number} nB 下一列（右列）节点数 1~3
     * @returns {Object} { from: [targetIndexes...] }，key 为本列节点索引(0起)，value 为下列要连接的目标索引数组。
     *
     * 规则（索引 0=上，中间=中，末尾=下）：
     *  2-2 / 1-x / x-1 及其它 → 每个本列节点连到下列全部节点（遍历/交叉）。
     *  3-3 → 中(索引1) 连下列全部；上(0) 连下列上/中；下(2) 连下列中/下。
     *  2-3 → 本列(2端) 上(0) 连下列(3端) 上/中；下(1) 连下列 中/下。
     *  3-2 → 本列(3端) 上(0)→下列上；中(1)→下列上/下；下(2)→下列下。
     */
    _computeConnections(nA, nB) {
      // 遍历全连：本列每个节点(0..nA-1) → 下列每个节点(0..nB-1)
      const all = () => {
        const map = {};
        for (let i = 0; i < nA; i++) {
          map[i] = [];
          for (let j = 0; j < nB; j++) map[i].push(j);
        }
        return map;
      };
      // 3-3
      if (nA === 3 && nB === 3) {
        return { 0: [0, 1], 1: [0, 1, 2], 2: [1, 2] };
      }
      // 2-3（本列 2 端）
      if (nA === 2 && nB === 3) {
        return { 0: [0, 1], 1: [1, 2] };
      }
      // 3-2（本列 3 端）
      if (nA === 3 && nB === 2) {
        return { 0: [0], 1: [0, 1], 2: [1] };
      }
      // 其它（含 2-2、1-x、x-1）→ 遍历全连
      return all();
    },

      /** 闲暇娱乐：随机挑一位"超出正史"的角色——优先标本库（返回完整标本键以保留身份），否则非作战池（纯名）；无时间点。 */
      _pickLeisureName() {
        try {
          const v = readVars(this.win);
          // 标本库是两层（时间线编号 → 卡），走 specKeys 取全库卡键（不能把组号当人名挑出来）
          const allSpec = specKeys(v);
          if (allSpec.length) {
            // 返回完整标本键（如 "霜星1234"），保留其"哪条世界线的她"的身份；没后缀才回退纯名
            const k = allSpec[Math.floor(Math.random() * allSpec.length)];
            return isSpecimenKey(k) ? k : cleanName(k);
          }
          const nc = NodePools['noncombat'] ? Object.keys(NodePools['noncombat']) : [];
          // 排除已在编队（携带）中的干员（精确匹配纯名，标本键剥后缀比对）
          const carried = new Set(Object.keys((v['干员编队'] || {})).map((n) => cleanName(n)));
          const cands = nc.filter((n) => !carried.has(n) && isNameEnabled(n));
          if (cands.length) return cands[Math.floor(Math.random() * cands.length)];
        } catch (e) {}
        return '';
      },

    // ====================================================================
    // 前端随机掷骰 + 选项生成（统一单一选项系统）
    //   选项统一存于「节点界面.options」（每个选项对象 z.record 内）：
    //     - label / desc   ：不带前缀，AI 可见可写（供它命名覆盖；初值=兜底名兼性能提示）
    //     - $kind/$payload/$oneShot/$$收人/$$令彩蛋 ：带 $ 前缀子项，AI 不可见不可改
    //   渲染/执行时把 $ 子项映射回 kind/payload 等（见 _optsFromVar/_optsToVar），
    //   方便复用节点界面按钮渲染，也方便以后接洁尔佩塔盲写。
    //   掷骰流程：必定单项池纯随机抽1 → 数值在范围内锁定 → ~30% 复合（正/负随机取1）。
    // ====================================================================
    _randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); },
    _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },

    /** 由 kind 取兜底 label（兼性能摘要；AI 犯蠢可见即为彩蛋提示） */

    /** 由池条目 + 数值范围生成一个具体选项对象（含 $ 前缀玩法子项）。 */


    /** 生成某节点类型的随机选项集（必定项 + 30% 复合），返回带 $ 子项的选项数组。 */

    /**
     * 收人选项：常驻；不期而遇/闲暇娱乐有女干员对象时追加一条。
     *  - 效果恒为招募该对象；标题/副标题由 AI 命名。
     *  - 不期而遇：首次进入随机填入消耗（多轮保持）；闲暇娱乐：必定无消耗。
     */

    /** 令彩蛋选项：仅闲暇娱乐+对象令时必定追加。无限次、加核心生命、较贵启动门槛、不进三池。 */

    /** 作战结算随机收藏品「原子」：从 CombatCollectPool 抽一个（避免重复，按 tag 去重），无候选则 null。 */

    /**
     * █ 统一"前端触发 → 准备一轮交互"（黄金循环②③）。
     *   清上一轮变量 → 生成本轮选项（$玩法项 + label 待命名）→ 写回变量「节点界面.options」。
     *   - type 为节点类型；若传 ctx.options 则直接用（否则复用 _setupNodeOptions 掷骰生成）。
     *   - 返回"待 AI 命名项"数组（source==='ai'），调用方据此拼 perfSummary。
     *   - 固定项（离开/结算收益/招募）不在此列，不进 perfSummary，也不写入 options 变量。
     */

    /**
     * █ 黄金循环⑤⑥：根据当前节点类型，算出"下一轮"的完整选项，并写回界面。
     *   结束后返回 { nextOpts, perf }：
     *     nextOpts: 下一轮待 AI 命名项（前端 options 数组，source:'ai'），已写入 State.nodeUI.options
     *     perf    : _perfSummary 片段（供拼进触发的回复）
     *   由 _nodeConfirm 在玩家确认后调用。
     */

    /**
     * 进入不期而遇/安全屋/闲暇娱乐时，生成完整选项集并写入「节点界面.options」。
     * type：不期而遇 / 安全屋 / 闲暇娱乐。
     * 包含：掷骰基础项 + 收人常驻（有目标时）+ 令彩蛋（闲暇娱乐+令）+ 不期而遇两轮流程初态。
     * 用户设定：不期而遇固定两轮——第一轮=收益选项+带走+直接走；
     * 玩家第一轮选了收益选项才触发第二轮（AI 先写剧情再给带走/直接走两个选项）；
     * 第一轮直接带走或直接走则无第二轮。
     * 返回 { options, meta }，options 为带 $ 子项的数组（直接可写 options 变量）。
     */

    /** 从选项的 $ 前缀玩法子项同步 kind/payload（渲染/执行时复用；AII 不可见）。 */

    /**
     * 生成"能力选项性能摘要"战报段，供 AI 反向命名（AI 只反推名称/副标题，数值已在前端定死）。
     * 只报 label 初值(兜底名)以内的性能提示，不泄露底层实现。
     * 关键：把每个选项在「节点界面.options」里的【键名】一并带出，AI 才能把起的名字写回对应选项
     * （写该键的 label/desc，勿动 $ 子项）。键名清洗规则与 _optsToVar 完全一致。
     */

    // ================= P3 计算引擎（长期池现算 / 收藏品归账 / 特殊战斗裁定） =================
    _round2(x) { return Math.round((Number(x) || 0) * 100) / 100; },

    /** 前端消息统一封装：<eventp> 包裹 + System: 前缀（AI 侧"舞台提示/结算"，与玩家输入严格区分） */
    _sys(t) { return '<eventp>System: ' + (t || '') + '</eventp>'; },

    /**
     * 隐藏关变量同步：扫 `收藏品`，哪件隐藏关收藏品已到账就把对应变量 f→t。
     * 这是**唯一**的置位入口 —— 命中随机时不动变量（AI 那时还不知道这条世界线），
     * 只有收藏品真正落账才转 t，随即关闭该族渠道、由用户自建 EJS 接管这条世界线的叙事。
     * ⚠ 收藏品与本变量都是**本局数据**（见 _resetRunScopedDraft），本局结束后一律复位。
     * 幂等：只在 f→t 时写库，可放心在多个时机重复调用。
     * @returns {string[]} 本次真正翻转的 id
     */
    _syncHiddenFlags() {
      const flipped = [];
      try {
        const v = readVars(this.win);
        const cds = v['收藏品'] || {};
        const bag = (v['$隐藏关'] && typeof v['$隐藏关'] === 'object') ? v['$隐藏关'] : {};
        const todo = HIDDEN_EVENTS.filter((e) => !bag[e.id] && hasNamed(cds, e.收藏品.名));
        if (!todo.length) return flipped;
        writeVars(this.win, (d) => {
          const t = d['$隐藏关'] = (d['$隐藏关'] && typeof d['$隐藏关'] === 'object') ? d['$隐藏关'] : {};
          todo.forEach((e) => { t[e.id] = true; flipped.push(e.id); });
        });
      } catch (e) { /* 变量层异常不影响主流程 */ }
      return flipped;
    },

    /** 某事件的前置条件是否满足（蚀刻章/收藏品名称匹配，空字符串 = 不需要）。 */
    _hiddenPrereqOK(ev, vars) {
      const v = vars || readVars(this.win);
      if (ev.前置蚀刻章 && !hasNamed(v['蚀刻章'], ev.前置蚀刻章)) return false;
      if (ev.前置收藏品 && !hasNamed(v['收藏品'], ev.前置收藏品)) return false;
      return true;
    },

    /**
     * 掷一次隐藏关（**只在进入「不期而遇」节点时调用一次**，结果冻结进 $切片.$隐藏关）。
     *   ① 族内互斥：该族**任一**变量已 t → 整族不再掷；
     *   ② 前置条件：不满足的事件不参与（如 特殊源石 需持有蚀刻章「灭世圣女-救世魔王」）；
     *   ③ 逐族各掷一次自己的概率；命中后从该族候选中**随机取一个**；
     *   ④ 两族都命中 → 取 优先级 高者，另一族本次**不消耗**（下次进不期而遇还能再掷）。
     * @returns {object|null} 命中的事件定义
     */
    _rollHiddenEvent() {
      try {
        // 防冲突（与 _enterNode 同口径的第二道闸）：隐藏层内不掷隐藏关 —— 第六层已经是那条世界线本身。
        if ((Number(State.currentLayer) || 1) >= HIDDEN_LAYER) return null;
        const v = readVars(this.win);
        const bag = (v['$隐藏关'] && typeof v['$隐藏关'] === 'object') ? v['$隐藏关'] : {};
        // 短对局：节点总数少约 40%（24 级 → 14 级），隐藏关概率 ×2 补偿，否则隐藏层几乎摸不到。
        //   只放大概率，掷骰结构不变（仍是逐族一次、族内互斥、前置条件照旧）；封顶 100%。
        const probMul = this._shortRunOn() ? SHORT_HIDDEN_PROB_MUL : 1;
        const winners = [];
        HIDDEN_FAMILIES.forEach((fam) => {
          const pool = HIDDEN_EVENTS.filter((e) => e.家族 === fam);
          if (!pool.length) return;
          if (pool.some((e) => !!bag[e.id])) return;                    // ① 族内任一为 t → 整族关闭
          const cands = pool.filter((e) => this._hiddenPrereqOK(e, v));  // ② 前置条件
          if (!cands.length) return;
          const prob = Math.min(1, (Number(cands[0].概率) || 0) * probMul);
          if (Math.random() >= prob) return;                            // ③ 整族一次掷骰
          winners.push(cands[Math.floor(Math.random() * cands.length)]);
        });
        if (!winners.length) return null;
        winners.sort((a, b) => (b.优先级 || 0) - (a.优先级 || 0));        // ④ 高优先级优先，其余不消耗
        return winners[0];
      } catch (e) { return null; }
    },

    /**
     * 拼隐藏关的战报后缀（**替换**掉常规那句"提供选项"，而不是追加在后面，
     * 否则"给 2~4 个选项"会和"只能包含一个选项"直接打架）。
     * 「此刻」文案留空则退回一句通用骨架，方便先跑通再手写。
     */
    _hiddenReportSuffix(ev) {
      const c = ev.收藏品;
      // 按类型生成写入模板；旧式（值+标签）隐藏层收藏品保持兼容回写
      const ct = this._collectibleType(c);
      let writeCd = '收藏品."' + c.名 + '" = { 描述:"…", 类型:"' + ct + '"';
      if (ct === '年份对撞') {
        const yr = (c.年份 != null && String(c.年份).trim() !== '') ? c.年份 : c.标签;
        writeCd += ', 年份:' + Number(yr) + ', 值:' + Number(c.值);
      } else if (ct === '三维固定') {
        if (c.三维 && (c.三维.未来 != null || c.三维.过往 != null || c.三维.现实 != null)) {
          writeCd += ', 三维:{ 未来:' + Number(c.三维.未来) + ', 过往:' + Number(c.三维.过往) + ', 现实:' + Number(c.三维.现实) + ' }';
        } else if (c.标签 === '未来' || c.标签 === '过往' || c.标签 === '现实') {
          writeCd += ', 值:' + Number(c.值) + ', 标签:"' + String(c.标签) + '"';  // 旧单轴写法回写，前端仍兼容
        }
      }
      writeCd += ' }';
      return '\n\n【隐藏世界线·' + ev.id + '】\n'
        + (String(ev.此刻 || '').trim() || ('【待你手写】' + ev.id))
        + '\n本条只给一个选项：领取收藏品「' + c.名 + '」，并收服此间目标角色。'
        + '\n收服：以纯干员名为键写入 干员编队。'
        + '\n收藏品落账：' + writeCd + '。'
        + '\n不出其它分支。';
    },

    /**
     * 收藏品类型判定（唯一口径）：显式读 `类型` 字段；缺省按数据形状推断（兼容旧数据）。
     * 返回：'年份对撞' | '三维固定' | '纯叙事'（旧"标签=三轴名"的单轴长期型也归入 三维固定 的读取路径，
     * 由调用方再按 标签 分支处理——见 _recomputeLongPool / _computeNodeAxes）。
     */
    _collectibleType(c) {
      if (!c || typeof c !== 'object') return '纯叙事';
      const t = String(c.类型 || '').trim();
      if (t === '年份对撞' || t === '三维固定' || t === '纯叙事') return t;
      // 缺类型：形状推断（旧数据兼容）
      const ax3 = c.三维;
      if (ax3 && typeof ax3 === 'object' && (ax3.未来 != null || ax3.过往 != null || ax3.现实 != null)) return '三维固定';
      const tag = c.标签;
      if (tag != null && String(tag).trim() !== '') {
        const s = String(tag).trim();
        if (/^-?\d+(\.\d+)?$/.test(s)) return '年份对撞';      // 数字标签 = 旧对撞写法
        if (s === '未来' || s === '过往' || s === '现实') return '三维固定'; // 旧长期单轴：读取路径同三维固定
      }
      return '纯叙事';
    },

    /**
     * 长期池现算：基底干员三维污染 → 逐层 ×$衰减档 → 叠"长期型"收藏品(标签=未来/过往/现实)。
     * 结果写 _长期总池（AI 只读可见）；顺带把新收藏品登记到 $收藏品获得层（逐层重放用）。
     */
    _recomputeLongPool() {
      this._syncHiddenFlags();   // 收藏品到账 → 隐藏关变量 f→t（长期池每次重算，顺带同步最省事）
      const v = readVars(this.win);
      const roster = v['干员编队'] || {};
      const baseKey = (v._探索进程 && v._探索进程.$基底干员) || '';
      const base = baseKey ? roster[baseKey] : null;
      const layer = Math.max(1, Number((v._探索进程 && v._探索进程.$当前层数) || 1) || 1);
      const decay = Number(v['$衰减档'] != null ? v['$衰减档'] : this._diffCtx().decay) || this._diffCtx().decay;
      const cds = v['收藏品'] || {};
      const ledgerIn = (v['$收藏品获得层'] && typeof v['$收藏品获得层'] === 'object') ? v['$收藏品获得层'] : {};
      const bp = (base && base.污染) || {};
      const cur = { 未来: Number(bp.未来) || 0, 过往: Number(bp.过往) || 0, 现实: Number(bp.现实) || 0 };
      const self = this;
      const gainOfLayer = (L) => {
        Object.keys(cds).forEach((nm) => {
          if (Number(ledgerIn[nm]) !== L) return;
          const c = cds[nm] || {};
          const type = self._collectibleType(c);
          if (type === '年份对撞') return;  // 对撞型：不进长期池，由节点内 _computeNodeAxes 对撞
          if (type === '三维固定') {
            // ① 新写法：三维 = { 未来:N, 过往:N, 现实:N }（轴固定、可负，逐层叠加并随层衰减）
            const ax3 = (c.三维 && typeof c.三维 === 'object' && (c.三维.未来 != null || c.三维.过往 != null || c.三维.现实 != null)) ? c.三维 : null;
            if (ax3) {
              cur.未来 += Number(ax3.未来) || 0;
              cur.过往 += Number(ax3.过往) || 0;
              cur.现实 += Number(ax3.现实) || 0;
              return;
            }
            // ② 兼容：旧"标签=未来/过往/现实"单轴长期型（隐藏层等旧收藏品）→ 同一读取路径
            const tag = c.标签;
            const axis = (tag === '未来' || tag === '过往' || tag === '现实') ? tag : null;
            if (axis) cur[axis] += Number(c.值) || 0;
            return;
          }
          // 纯叙事：无数值效果
        });
      };
      // 逐层重放：**按"层序"走，不按层号数**。
      //   · 正常对局层序 = [1,2,3,4,5] → 与改造前的 `for L=1..layer` 逐位等价；
      //   · 短对局层序 = [1,3,5] → 跑完三层只发生 **2 次**层间衰减（作者拍板口径）；
      //   · 隐藏层 6 仍在层序末尾：进隐藏层后再衰减一次，与正常对局同构。
      //   `$收藏品获得层` 里存的是层号，因此短对局第 1 层拿到的收藏品只被削 2 次 —— 账本零改动。
      const seq = this._layerSeq().filter((L) => L <= layer);
      const steps = seq.length ? seq.length : 1;
      for (let i = 0; i < steps; i++) {
        gainOfLayer(seq[i]);
        if (i < steps - 1) { cur.未来 *= decay; cur.过往 *= decay; cur.现实 *= decay; }
      }
      // 去量化：全体干员取最高；仅当【多人并列最高】时才 +1（不再因多人人数 +1；不被层削减）
      // 难度3+：每过一层 战力 −1（只改动长期池数值，不改干员信息）——与每层削轴同口径，
      //   "过层数"同样按**层序**算：正常 = 层号−1，短对局 = 已走层数−1（三层 → −2）。
      const opNames = Object.keys(roster);
      let maxQ = 0, ties = 0;
      opNames.forEach((n) => {
        const q = Number((roster[n] || {}).去量化) || 0;
        if (q > maxQ) { maxQ = q; ties = 1; }
        else if (q === maxQ && q > 0) ties++;
      });
      const layPowPenalty = this._diffCtx().layerPowerPenalty || 0;
      const deq = Math.max(0, maxQ + (ties > 1 ? 1 : 0) - layPowPenalty * Math.max(0, steps - 1));
      const nowNames = Object.keys(cds);
      writeVars(this.win, (d) => {
        const ld = d['$收藏品获得层'] = (d['$收藏品获得层'] && typeof d['$收藏品获得层'] === 'object') ? d['$收藏品获得层'] : {};
        nowNames.forEach((nm) => { if (ld[nm] == null) ld[nm] = layer; });
        const lp = d['_长期总池'] = d['_长期总池'] || { 污染: { 未来: 0, 过往: 0, 现实: 0 }, 去量化: 0 };
        lp.污染 = { 未来: self._round2(cur.未来), 过往: self._round2(cur.过往), 现实: self._round2(cur.现实) };
        lp.去量化 = self._round2(deq);
      });
    },

    /**
     * 特殊战斗触发：读 $切片(时间点/敌方) → 我方临时池=长期池 + 时间点型收藏品对撞(仅本次节点)
     * → 敌我裁定 → 软/硬战报文案。软=所知<0(和平线，参考不锁结果)；硬=正常裁定。
     * 敌方卡缺失时返回"请先建卡"提示。
     */
    _computeBattleReport() {
      this._recomputeLongPool(); // 确保长期池已含最新长期型收藏品/层衰减
      const v = readVars(this.win);
      const ni = v['$切片'] || {};
      const year = Number(ni.$当前时间点) || 1094;
      const enemyName = ni.$当前敌方 || '';
      // 最终三轴 = 长期池(长期型收藏品+层衰减) 再叠加本节点时间点型收藏品对撞
      const { axes: t } = this._computeNodeAxes();
      const enemy = enemyName ? (v['敌方库'] || {})[enemyName] : null;
      if (!enemy) {
        return '（敌方卡缺失：' + (enemyName ? ('<' + enemyName + '>') : '对手') + '的量化/三维抗性/痴愚未写入 敌方库。写入后触发战斗。）';
      }
      const known = Number((v.玩家资源 || {}).所知) || 0;
      const soft = known < 0; // 阈值 0：所知 < 0 → 软性参考战报（和平线预留）
      const self = this;
      const bt = this._evalBattle(t, Number((v['_长期总池'] || {}).去量化) || 0, known, enemy);
      const verdictTxt = self._battleVerdictText(bt, Number((v['_长期总池'] || {}).去量化) || 0, enemy, known);
      writeVars(this.win, (d) => { const sl = d['$切片'] = d['$切片'] || {}; sl.$软硬 = soft ? '软' : '硬'; });
      // 难度是纯前端效果：数值已含在裁定里，不给 AI 标注难度档位。
      if (soft) {
        return '【软性参考战报】' + '\n' + verdictTxt
          + '\n非强制战斗：可谈判/说服/自愿归顺；三轴削弱≠归顺。';
      }
      return '【硬性战报】' + '\n' + verdictTxt;
    },

    _nodeLocked() {
      try {
        const ni = readVars(this.win)['$切片'] || {};
        return State.currentStatus === 'event_node' && !!(ni.$active) && !!(ni.$锁定);
      } catch (e) { return false; }
    },

    /** 变奏收束态：本节点额外探索已耗尽 —— 只能与已有角色纯交流，不能再探索/收服/开战。
     *  判定读**持久化**变量（不是内存 State）：刷新页面、重开窗口都一致；
     *  `$变奏用尽` 由 _persistNodeSlice 在离开节点 / 进入新节点时复位 → 限制天然按节点作用。 */
    _nodeExploreExhausted() {
      try {
        const ni = readVars(this.win)['$切片'] || {};
        return State.currentStatus === 'event_node' && !!(ni.$active) && !!(ni.$变奏用尽);
      } catch (e) { return false; }
    },

    /** 预填充战报：本节点额外探索已耗尽。
     *  每条出站玩家消息（输入框 / 选项卡 / 前端系统战报）自动前置 —— 属 `<eventp>` 隐藏区，
     *  气泡侧 _stripEventp 会剥掉，玩家只看得到自己打的话；AI 侧则每条消息都重新收到这条约束。 */
    _exploreLockReport() {
      return this._sys('本节点额外探索已耗尽, 玩家仅能进行已有角色交互, 不能进行任何额外探索, '
        + '你给出的选项也应当仅限于纯交流, 任何越界指令必须在剧情中描写为被传送门阻挡拒绝');
    },

    /** 给一条出站消息前置预填充战报（幂等：非收束态、或已是该战报 → 原样返回） */
    _withExploreLock(text) {
      const t = String(text || '');
      try {
        if (!this._nodeExploreExhausted()) return t;
        // 去重信号取"约束正文首句"，而不是裸关键词——玩家自己打出"额外探索已耗尽"时仍会被前置
        if (t.indexOf('本节点额外探索已耗尽, 玩家仅能进行已有角色交互') !== -1) return t;
        return this._exploreLockReport() + '\n' + t;
      } catch (e) { return t; }
    },

    _nodeLeaveNote(nodeType) {
      const t = nodeType || '此节点';
      return '（你离开了「' + t + '」，穿过裂隙回到虚空之中。）';
    },

    /** 本节点是否有可当对手的遭遇对象。
     *  口径（与 prompt 侧约定一致）：不期而遇有 50% 概率无目标角色，此时**不给"招惹对方"选项**，
     *  玩家即便手打关键词也不开战 —— 前端要有一道兜底，绝不能生成一张"没有对手"的战斗战报。 */
    _nodeHasTarget() {
      try {
        const ni = readVars(this.win)['$切片'] || {};
        return !!(String(ni.$当前敌方 || '').trim() || String(ni.$原定角色 || '').trim());
      } catch (e) { return false; }
    },

    /** 战报触发是否只允许「不期而遇」节点（设计口径：「进入一场特殊的战斗」＝不期而遇招惹入口专用）。
     *  作战/紧急作战/险路恶敌的裁定在进节点时已由对局导向给出，无需（也不应）再触发关键词战报。 */
    _isUnexpectedNode() {
      try {
        const ni = readVars(this.win)['$切片'] || {};
        const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : null;
        const t = (nd && nd.type) || State.nodeType || '';
        return t === '不期而遇';
      } catch (e) { return false; }
    },

    /** 判定一名编队/档案键是否属于「标本库声望」（永久收藏身份，区别于野生遭遇）。
     *  三层依据（任一命中即标本）：① 档案 身份 === '标本'；② 档案带有 标本键（原型标本键）；
     *  ③ 标本库（按时间线分组，走 specFind 全库找）中存在该键；
     *  ④ 键符合标本身份格式「名 + 四位时间线编号」（如 `阿米娅1234`；旧 `名_ab` 也认）——
     *     兜底，误差方向安全（偏向"不算变奏"，避免误锁节点）。 */
    _unitIsSpecimen(key, rec, vars) {
      const k = String(key || '');
      if (!k) return false;
      if (rec) {
        if (String(rec.身份 || '') === '标本') return true;
        if (typeof rec.标本键 === 'string' && rec.标本键) return true;
      }
      try { if (specFind(vars, k)) return true; } catch (e) {}
      return isSpecimenKey(k) || /_[0-9a-z]{2}$/.test(k);
    },

    /** 变奏审计：本节点收服**第二个**角色（第一个＝主目标）才叫变奏 → 置 `$变奏用尽`，
     *  此后本节点只能纯交流（每条玩家消息前置预填充战报，见 _withExploreLock），直到玩家自行离开。
     *  · 不弹窗、不锁定、不自动离开：出口交给通用「离开节点」卡（_appendLeaveCard → _pickActionOption → _leaveNode）。
     *  · **绝不复用 `$锁定`**：那一条会把输入框 readOnly、发送按钮、正文选项、_pickActionOption 全部封死
     *    （见 switchView / handleSend / _parseActionOptions），与"玩家仅能进行已有角色交互"正好相反。
     *  · 限制按节点生效：离开节点与进入新节点都由 _persistNodeSlice 复位 `$变奏用尽`，无需额外清理。 */
    _auditNodeVariant() {
      try {
        const v = readVars(this.win);
        const ni = v['$切片'] || {};
        if (!ni.$active || State.currentStatus !== 'event_node') return;
        // 诡意行商：独立于时空的交易节点，购买过程可自由招募多名干员，不参与变奏审计（无原定目标/额外收服限制）
        try {
          const ndt = (ni.$nodeData && ni.$nodeData.type) || State.nodeType || '';
          if (ndt === '诡意行商') return;
        } catch (e) {}
        if (ni.$锁定 || ni.$变奏用尽) return;
        const roster = v['干员编队'] || {};
        const baseline = Array.isArray(ni.$收服基线) ? ni.$收服基线 : [];
        const declared = String(((v['行动'] || {}).原定目标) || '').trim(); // AI 声明的主角色优先
        const designatedRaw = declared || ni.$原定角色 || '';
        const designated = cleanName(designatedRaw);
        // 变奏差分豁免（每钥判定）：
        //   ① 进节点快照内；② 精确整键＝主目标（标本键/改名键也能精确命中）；
        //   ③ 档案标本键＝主目标；④ ★标本库声望者（标本身份/标本键/标本库成员/编号后缀）永不当"新增"——
        //      标本干员在任何节点被带入、请回、改名都不算变奏；⑤ 裸名主目标豁免保持不动
        //      （若主目标是标本身份，则裸名同名者不再豁免——原角色与标本角色不搞混）。
        const added = Object.keys(roster).filter((k) => {
          if (baseline.includes(k)) return false;
          if (k === designatedRaw || k === designated) return false;
          const rec = roster[k] || {};
          if (rec.标本键 && rec.标本键 === designatedRaw) return false;
          if (this._unitIsSpecimen(k, rec, v)) return false;
          if (cleanName(k) === designated && !this._unitIsSpecimen(designatedRaw, roster[designatedRaw] || {}, v)) return false;
          return true;
        });
        if (!added.length) return;
        // ★ 变奏的前提＝**第一个角色已经收服**（变奏＝第二个角色）。缺这道判定会误判两种场面：
        //   · 有主目标的作战节点：主目标未收服前旁人人队 → 被判变奏收束，而这类节点的离开卡正被
        //     _nodeCanLeave 门控挡着（主目标未入队不渲染）→ 玩家会陷进"提示只能纯交流却走不了"；
        //   · 无主目标节点（安全屋 / 无目标不期而遇 / 闲暇娱乐）：`$原定角色` 与 `行动.原定目标` 都空，
        //     任何一次收人都会被当成"第二人"——本节点第一个角色不算变奏，第二个起才算。
        const firstIn = designated
          ? Object.keys(roster).some((k) => k === designatedRaw || cleanName(k) === designated)  // 主目标已入编队
          : added.length >= 2;                                                                  // 无主目标：第二个新人才是变奏
        if (!firstIn) return;
        this._persistNodeSlice({
          active: true, status: 'event_node', nodeData: ni.$nodeData, year: ni.$当前时间点, 敌方: ni.$当前敌方,
          变奏用尽: true, 额外收服完成: true, 待定: true,
        });
        // 变奏收束通知（M2c）：`$变奏用尽` 属 `$` 隐藏区，AI 根本看不见这个变量，
        // 所以必须在收束时**主动告知**，否则 AI 会继续安排第三次额外收服。
        // ⚠ 不再自动 `_leaveNode()`：本节点此后由玩家自行点通用「离开节点」卡离开。
        //    本条通知随后的 `_withExploreLock` 会自动前置"额外探索已耗尽"预填充战报。
        const second = cleanName(added[0]) || '她';
        // 这条消息自带约束原文（等于 _withExploreLock 的前缀）:即使 200ms 时 MVU 还没把
        // `$变奏用尽` 提交给读视图,约束也不会漏发;它含信号句,所以 _withExploreLock 会识别并去重。
        const notice = this._exploreLockReport() + '\n'
          + this._sys('已收服本节点主目标之外的' + (second === '她' ? second : ('<' + second + '>'))
            + '。把这一幕收尾即可：此后不要安排任何新的收服、战斗或探索，也不要写出离开此间——离开由玩家自行决定。');
        setTimeout(() => {
          try { Engine._sendAsUser(this.win, notice); } catch (e) {}
        }, 200);
      } catch (e) { console.warn('[集成战略] _auditNodeVariant 出错', e && e.message); }
    },

    // ================= A1–A4 UI：编队/晋升/检视/收藏/长期池雷达 =================
    _num(x) { return Math.round((Number(x) || 0) * 100) / 100; },

    // ================= 难度 / 分队 =================
    /** 当前难度档位（0~5）。纯前端读变量；难度效果全部在前端叠加，AI 只读参考。 */
    _diffLevel() {
      try {
        const v = readVars(this.win);
        const n = Math.trunc(Number((v['$难度'] || {}).档位));
        return isFinite(n) ? Math.max(0, Math.min(6, n)) : 1;
      } catch (e) { return 1; }
    },

    /** 当前晋升单价：默认 4 源石/人；难度 4 起 5 源石/人。前端唯一权威口径。 */
    _promoteCost() {
      return diffCtx(this._effDiff()).promoteCost;
    },

    /**
     * 幂等同步「晋升报价」到 AI 可见变量 `_探索进程._晋升花费`。
     *  · **键名带 `_` 前缀 = AI 只读**（世界书铁律：`_` 开头的键只读、绝不改写），报价由前端按难度自动算，
     *    不给 AI 自行填价/改价的机会；这条同步就是"自动跳闸"：AI 万一写了别的内容，下一轮立刻按难度改回来。
     *  · 报价取 **`$难度.档位`（变量）** 而不是 `_effDiff()`（内存暂存优先）：落盘的东西必须跟落盘的档位一致，
     *    否则主城难度轮盘还没「确认并出发」时，暂存值会把开局的报价提前写歪。
     *  · 幂等：值与当前一致就不写（_persistGameState/_handleAiReply 会高频调用，不能每次落盘）。
     *  · 兜底：旧存档没有这个键、或 AI 误删/写坏后，任意一次落盘/回复就自愈；
     *    同时清掉历史遗留键 `晋升说明`（旧命名，无 `_` 前缀，留着会变成一条 AI 可见的重复文本）。
     */
    _syncPromoteSentence() {
      try {
        const want = promoteSentence(diffCtx(this._diffLevel()).promoteCost);
        const prog = (readVars(this.win)._探索进程) || {};
        const legacy = Object.prototype.hasOwnProperty.call(prog, '晋升说明');
        if (String(prog._晋升花费 || '') === want && !legacy) return false;
        writeVars(this.win, (d) => {
          const p = d['_探索进程'] = (d['_探索进程'] && typeof d['_探索进程'] === 'object') ? d['_探索进程'] : {};
          p._晋升花费 = want;
          if (Object.prototype.hasOwnProperty.call(p, '晋升说明')) delete p['晋升说明'];
        });
        return true;
      } catch (e) { return false; }
    },

    /** 当前生效难度口径的来源：优先"本局界面暂存值"，否则读变量（保证显示与结算一致） */
    _effDiff() {
      const n = Math.trunc(Number(State.pendingDifficulty));
      if (Number.isFinite(n)) return Math.max(0, Math.min(6, n));
      return this._diffLevel();
    },

    /** 当前难度的叠加系数上下文（衰减档/晋升单价/优势轴门槛/所知反转…） */
    _diffCtx() { return diffCtx(this._effDiff()); },

    /** 难度数字→展示字符：难度0 显示「0」，1~5 显示「Ⅰ」~「Ⅴ」 */
    _romanDiff(n) {
      const i = Math.trunc(Number(n));
      if (!isFinite(i) || i <= 0) return '0';
      return 'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ'[i - 1] || String(i);
    },

    /** 难度轮盘条目 + 效果清单（越往下越难，逐级叠加所有上级效果） */
    _diffWheelItems() {
      return [
        { 档: 0, 名: '标准', 简介: '一切不变', 效果: ['无任何额外修正'] },
        { 档: 1, 名: '受挫', 简介: '立足之地更窄', 效果: DifficultyRules[1].效果 },
        { 档: 2, 名: '侵蚀', 简介: '三轴随时间流失得更快', 效果: DifficultyRules[2].效果 },
        { 档: 3, 名: '衰竭', 简介: '长路磨蚀：每过一层战力 −1', 效果: DifficultyRules[3].效果 },
        { 档: 4, 名: '昂贵', 简介: '改造她的代价更高', 效果: DifficultyRules[4].效果 },
        { 档: 5, 名: '压制', 简介: '单轴优势已不够用', 效果: DifficultyRules[5].效果 },
        { 档: 6, 名: '悖论', 简介: '你所以为的"了解"开始反噬', 效果: DifficultyRules[6].效果 },
      ];
    },

    /** 主界面难度按钮：全屏上下滑动轮盘——每级一行，显示难度数字与叠加效果，点确认返回主界面 */
    _openDifficultyWheel() {
      const doc = this.win.document;
      const cur = Number.isFinite(State.pendingDifficulty) ? State.pendingDifficulty : this._diffLevel();
      const items = this._diffWheelItems();
      const old = doc.getElementById('diff-wheel-overlay');
      if (old) old.remove();

      const overlay = doc.createElement('div');
      overlay.id = 'diff-wheel-overlay';
      overlay.className = 'diff-wheel-overlay';
      const total = items.length;

      const rows = items.map((it, i) => {
        const cls = 'dw-item' + (it.档 === cur ? ' selected' : '');
        const eff = it.效果.map((e) => '<div class="dw-eff">· ' + this._escapeHtml(e) + '</div>').join('');
        return '<div class="' + cls + '" data-i="' + i + '">'
          + '<div class="dw-item-top">'
          + '<div class="dw-num">' + this._escapeHtml(this._romanDiff(it.档)) + '</div>'
          + '<div><div class="dw-name">难度 ' + it.档 + '　' + this._escapeHtml(it.名) + '</div>'
          + '<div class="dw-sub">' + this._escapeHtml(it.简介) + '</div></div>'
          + '</div>'
          + '<div class="dw-effs">' + eff + '</div>'
          + '</div>';
      }).join('');

      // ⚠ 可靠性优先：列表禁止手动滚动（overflow hidden + pointer-events none），
      // 只有点 ▲/▼ 才会触发一次程序化滚动换档 —— 不再依赖触摸/滚轮，也就不会"一闪弹回初始难度"。
      overlay.innerHTML = '<div class="diff-wheel-head">难度选择<span class="dif-hint">点击上下箭头切换难度</span></div>'
        + '<button class="dw-arrow" id="dw-up" title="上一个难度">▲</button>'
        + '<div class="diff-wheel-list" id="diff-wheel-list">' + rows + '</div>'
        + '<button class="dw-arrow" id="dw-down" title="下一个难度">▼</button>'
        + '<div class="diff-wheel-foot"><button class="big-btn btn-gold" id="diff-wheel-ok">确认</button>'
        + '<button class="mini-btn gray" id="diff-wheel-cancel">取消</button></div>';
      doc.body.appendChild(overlay);

      const list = overlay.querySelector('#diff-wheel-list');
      const rowsOf = () => list.querySelectorAll('.dw-item');
      let idx = Math.max(0, Math.min(total - 1, cur));   // 当前选中（0~6）

      /** 每行高度用**像素**固定（百分比高度受自身 padding 影响会循环变化）；首尾留白 = (列表高-行高)/2，
       *  保证首尾行也能滚到正中。配合 position:relative，row.offsetTop 相对本列表，scrollTo 目标精确。 */
      const layoutWheel = () => {
        const rows = rowsOf();
        if (!rows.length) return;
        // 行高下限：桌面 96px；紧凑档（手机横屏约 393px 高）降到 66px，
        // 否则 7 档轮盘一次只能露出 2 档，上下箭头要按很多次。
        const minH = this.body.classList.contains('ui-compact') ? 66 : 96;
        const itemH = Math.max(minH, Math.floor(list.clientHeight / total));
        rows.forEach((el) => { el.style.height = itemH + 'px'; });
        const pad = Math.max(8, Math.floor((list.clientHeight - itemH) / 2));
        list.style.paddingTop = pad + 'px';
        list.style.paddingBottom = pad + 'px';
      };
      /** 把第 i 条滚到轮盘正中（并高亮） */
      const centerOn = (i, smooth) => {
        const row = rowsOf()[i];
        if (!row) return;
        list.scrollTo({ top: row.offsetTop - (list.clientHeight - row.offsetHeight) / 2, behavior: smooth ? 'smooth' : 'auto' });
      };
      const render = () => {
        rowsOf().forEach((el, k) => el.classList.toggle('selected', k === idx));
        overlay.querySelector('#dw-up').disabled = idx <= 0;
        overlay.querySelector('#dw-down').disabled = idx >= total - 1;
      };
      /** 唯一换档入口：点击箭头 → 移动一格并程序化滚动 */
      const step = (delta) => {
        const next = Math.max(0, Math.min(total - 1, idx + delta));
        if (next === idx) return;
        idx = next;
        render();
        centerOn(idx, true);
      };
      // 初始定位到当前档位（无动画）
      const boot = () => { layoutWheel(); render(); centerOn(idx, false); };
      requestAnimationFrame(boot);
      setTimeout(boot, 30);

      overlay.querySelector('#dw-up').onclick = () => step(-1);
      overlay.querySelector('#dw-down').onclick = () => step(1);

      overlay.querySelector('#diff-wheel-ok').onclick = () => {
        State.pendingDifficulty = Math.max(0, Math.min(6, idx));   // 行索引 == 档位（难度 0 起）
        overlay.remove();
        this._renderHome();                                          // 返回初始界面，数字显示已选难度
      };
      overlay.querySelector('#diff-wheel-cancel').onclick = () => overlay.remove();
    },

    /** 取某角色的个人背景图链（档案.背景 → 兜底 event_node 背景） */
    /** 取某角色专属背景（OperatorDB 档案.bg）；未分配则用默认地图背景。 */
    _stageBgFor(name) {
      const nm = cleanName(name || '');
      return (OperatorDB[nm] && OperatorDB[nm].bg) || BgMap['event_node'] || '';
    },

    /** 设置节点覆盖层背景（目标角色图 or 默认 CG） */
    _setNodeStageBg(name) {
      const el = this.win.document.getElementById('node-stage');
      if (!el) return;
      const bg = this._stageBgFor(name) || '';
      el.style.backgroundImage = bg ? `url("${bg}")` : '';
    },

    /** 三维污染雷达（三角）：每个顶点按各自轴的值独立取半径，让雷达真正反映三维差异而非一个等边占位三角形 */
    /** 三轴雷达。size 为可选显示尺寸（默认 120）；内部坐标固定，仅缩放 width/height。 */
    _radarSVG(pollArr, size) {
      const vals = [Number(pollArr && pollArr[0]) || 0, Number(pollArr && pollArr[1]) || 0, Number(pollArr && pollArr[2]) || 0];
      const maxV = Math.max(100, vals[0], vals[1], vals[2]);
      const scaleR = (val) => 46 * val / maxV;
      // 顶点 i 的角度（上、左下、右下 三等分）；data 三角形每个顶点用各自轴半径
      const px = (i, r) => {
        const a = Math.PI / 2 + i * 2 * Math.PI / 3;
        return (60 + Math.cos(a) * r).toFixed(1) + ',' + (58 - Math.sin(a) * r).toFixed(1);
      };
      const ring = (r) => [0, 1, 2].map((i) => px(i, r)).join(' ');
      const data = [0, 1, 2].map((i) => px(i, scaleR(vals[i]))).join(' ');
      const S = Number(size) || 120;
      const H = Math.round(S * 116 / 120);
      return '<svg width="' + S + '" height="' + H + '" viewBox="0 0 120 116">'
        + '<polygon points="' + ring(46) + '" fill="none" stroke="#3a3f4a"/>'
        + '<polygon points="' + ring(23) + '" fill="none" stroke="#2a2e38"/>'
        + '<polygon points="' + data + '" fill="rgba(122,200,255,.2)" stroke="#7ac8ff" stroke-width="1.5"/>'
        + '</svg>';
    },

    /** 三轴雷达（带顶点标注）：每个顶点外侧标明轴名（未来/过往/现实）与具体数值。
     *  @param enemyArr 可选：[未来,过往,现实]；提供时在其下方叠加一层**更透明的红色**敌方三维，
     *  与蓝色我方共存对比（战斗节点内用）。
     *  @param compact 可选：紧凑档（手机横屏）专用排版。**三角画幅不变**（半径仍 38，只是整块略微下移），
     *  省高度靠重排文字：
     *    · 「未来」的键与值**左右并排**（原来上下两行，白占一行高）；
     *    · 「过往 / 现实」相对三角**上移**到两个底角的外侧（原来掉到三角下方老远）；
     *    · 再把三角与三值整体下移一点（圆心 62 → 68），把下移让出的空间用掉；
     *    · 最后把 viewBox 裁到内容实际范围（0 4 120 88），渲染按 104 宽等比 → 不再有上下空边，
     *      所以「去量化 / 所知」那一行永远在图形下方，压不到顶点数值上。
     *  桌面档（compact 假）一个像素都没动。 */
    _radarSVGLabeled(pollArr, enemyArr, compact) {
      const CP = !!compact;
      const names = ['未来', '过往', '现实'];
      const vals = [Number(pollArr && pollArr[0]) || 0, Number(pollArr && pollArr[1]) || 0, Number(pollArr && pollArr[2]) || 0];
      const maxV = Math.max(100, vals[0], vals[1], vals[2]);
      // 紧凑档：画幅不变 → 半径仍是 38；整块略微下移 → 圆心 62 → 68
      const CX = 60;
      const R = CP ? 38 : 46;
      const CY = CP ? 68 : 58;
      const scaleR = (val) => R * val / maxV;
      const px = (i, r) => {
        const a = Math.PI / 2 + i * 2 * Math.PI / 3;
        return (CX + Math.cos(a) * r).toFixed(1) + ',' + (CY - Math.sin(a) * r).toFixed(1);
      };
      const ring = (r) => [0, 1, 2].map((i) => px(i, r)).join(' ');
      const data = [0, 1, 2].map((i) => px(i, scaleR(vals[i]))).join(' ');
      // 敌方红色层（同坐标系，独立缩放上限，避免被 100 上限压缩失真）
      let enemyPoly = '';
      if (enemyArr && enemyArr.length === 3) {
        const evals = [Number(enemyArr[0]) || 0, Number(enemyArr[1]) || 0, Number(enemyArr[2]) || 0];
        const emax = Math.max(100, evals[0], evals[1], evals[2]);
        const escaleR = (val) => R * val / emax;
        const edata = [0, 1, 2].map((i) => px(i, escaleR(evals[i]))).join(' ');
        enemyPoly = '<polygon points="' + edata + '" fill="rgba(255,92,92,.13)" stroke="#ff6a6a" stroke-width="1.5"/>';
      }
      const poly = '<polygon points="' + ring(R) + '" fill="none" stroke="#3a3f4a"/>'
        + '<polygon points="' + ring(R / 2) + '" fill="none" stroke="#2a2e38"/>'
        + enemyPoly
        + '<polygon points="' + data + '" fill="rgba(122,200,255,.2)" stroke="#7ac8ff" stroke-width="1.5"/>';

      if (CP) {
        // 紧凑档文字排版（几何都是上面这套坐标；三角顶角 (60,30)、两底角 (60±32.9, 87)）：
        //   · 未来：键「未来」右对齐到 x=56、值从 x=60 起 —— 同一基线 y=16 → 左右并排，
        //     贴着三角顶角上方，不越过图形框顶；
        //   · 过往 / 现实：上移到两个底角的外侧（y=74 键、y=88 值），文字整体落在三角左右两侧，
        //     不再掉到图形下方，于是底部空出一整行；
        //   · 三角与三值已在上面整体下移（圆心 68），底角 y=87 与「值」基线 88 基本齐平。
        const labels = `<text x="56" y="16" text-anchor="end" font-size="13" fill="#9fe3ff">${names[0]}</text>`
          + `<text x="60" y="16" text-anchor="start" font-size="14" font-weight="bold" fill="#ffffff">${this._num(vals[0])}</text>`
          + `<text x="4" y="74" text-anchor="start" font-size="13" fill="#9fe3ff">${names[1]}</text>`
          + `<text x="4" y="88" text-anchor="start" font-size="14" font-weight="bold" fill="#ffffff">${this._num(vals[1])}</text>`
          + `<text x="116" y="74" text-anchor="end" font-size="13" fill="#9fe3ff">${names[2]}</text>`
          + `<text x="116" y="88" text-anchor="end" font-size="14" font-weight="bold" fill="#ffffff">${this._num(vals[2])}</text>`;
        // viewBox 裁到内容实际范围：顶 2（「未来」那行字头之上留 1~2px）→ 底 94（两值基线 88 再留 6px），
        // 高度 92 → 与 120 同比例缩放，渲染时不产生任何拉伸。
        return '<svg width="120" height="92" viewBox="0 2 120 92">' + poly + labels + '</svg>';
      }

      // ── 桌面档：原样（上下两行、锚点在外圈之外、120×116 画布） ──
      const pts = [
        { x: 60, y: 6, anchor: 'middle' },
        { x: 10, y: 90, anchor: 'start' },
        { x: 110, y: 90, anchor: 'end' },
      ];
      const fsN = 10;     // 轴名字号
      const fsV = 11;     // 数值字号
      const dyV = 12;     // 数值相对轴名的下移量
      let labels = '';
      for (let i = 0; i < 3; i++) {
        const p = pts[i];
        labels += `<text x="${p.x}" y="${p.y}" text-anchor="${p.anchor}" font-size="${fsN}" fill="#9fe3ff">${names[i]}</text>`
          + `<text x="${p.x}" y="${p.y + dyV}" text-anchor="${p.anchor}" font-size="${fsV}" font-weight="bold" fill="#ffffff">${this._num(vals[i])}</text>`;
      }
      return '<svg width="120" height="116" viewBox="0 0 120 116">' + poly + labels + '</svg>';
    },

    /** HTML 转义（所有注入到 innerHTML 的玩家/AI 文本都要过这一道） */
    _esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
    },

    /**
     * 整页浏览器外壳：铺满顶栏以下的**整页**（top:48px ~ bottom:0），
     * 不做随条数挤压的悬浮窗。结构：
     *   #game-page > .pg-head（标题/统计/操作/关闭） + .pg-body（左详情 .pg-side + 右列表 .pg-main）
     */
    _openPage(innerHTML) {
      this._closePage();
      const pg = this.win.document.createElement('div');
      pg.id = 'game-page';
      pg.innerHTML = innerHTML;
      this.win.document.body.appendChild(pg);
      const c = pg.querySelector('#pg-close');
      if (c) c.onclick = () => this._closePage();
      return pg;
    },

    /** 关闭整页浏览器（切换视图时也会兜底调用，避免残留页盖住新画面） */
    _closePage() { const el = this.win.document.getElementById('game-page'); if (el) el.remove(); },

    _pageHeadHTML(title, sub, extra) {
      return '<div class="pg-head"><span class="pg-title">' + title + '</span>'
        + (sub ? '<span class="pg-sub">' + sub + '</span>' : '')
        + '<span class="pg-spacer"></span>' + (extra || '')
        + '<button class="mini-btn gray" id="pg-close">✕ 关闭</button></div>';
    },

    /**
     * 干员宽卡：左立绘（object-fit 裁到上半身）、左上状态缎带、左下去量化徽标、
     * 右侧「名称 + 迷你三轴雷达 + 数值」——对应参考图里卡片那一块。
     * 第 4 参 showIdx：true = 额外显示标本编号后缀（#xx，标本库里才用）。
     */
    _opCardHTML(k, op, sel, showIdx) {
      const nm = cleanName(k);
      const art = opArt(k, artEliteOf(op));
      const p = (op && op.污染) || {};
      const promoted = !!(op && op.已晋升);
      const stage = promoted ? '已晋升' : ((op && op.状态) || '—');
      const ribbonCls = promoted ? ' gold' : ((op && op.状态 === '正常') ? ' dim' : '');
      const idx = showIdx ? String(k).slice(nm.length).replace(/^_/, '') : '';
      return '<div class="du-card' + (sel ? ' sel' : '') + '" data-k="' + this._esc(k) + '">'
        + '<span class="du-ribbon' + ribbonCls + '">' + this._esc(stage) + '</span>'
        + '<div class="du-art"><img src="' + art + '" alt=""></div>'
        + '<div class="du-meta">'
        + '<div class="du-nm">' + this._esc(nm) + (idx ? '<span class="du-idx">#' + this._esc(idx) + '</span>' : '') + '</div>'
        + '<div class="du-row">'
        + '<span class="du-radar">' + this._radarSVG([p.未来, p.过往, p.现实], 74) + '</span>'
        + '<span class="du-nums">'
        + '<i>去量化 <b>' + this._num(op && op.去量化) + '</b></i>'
        + '<i>未 <b>' + this._num(p.未来) + '</b> 过 <b>' + this._num(p.过往) + '</b> 现 <b>' + this._num(p.现实) + '</b></i>'
        + '</span></div></div>'
        + '<span class="du-lv">' + this._num(op && op.去量化) + '</span>'
        + '</div>';
    },

    /**
     * 左栏详情（干员编队 / 标本库 **完全共用**）。
     *   mode='num'  → 数值色块 + 带轴名的三轴雷达
     *   mode='narr' → 叙事档案（外貌特征 / 色情设定 / 对玩家的态度 / 经历记录）
     * k 为空 → 空态提示（对应参考图的"轻触右侧干员以查看详情"）。
     * ⚠ source='标本库' 时：标题显示**完整标本键**（`阿米娅1234`；玩家改名后就是 `小阿米娅1234`），
     *   记录走 specFind（标本库是两层容器，直接按第一层下标取拿到的是"某个时间线组"）。
     */
    _opDetailHTML(k, source, mode) {
      if (!k) return '<div class="dt-empty">轻触右侧干员卡<br>查看她的数值与档案</div>';
      const v = readVars(this.win);
      const isSpec = source === '标本库';
      // 标本库 / 编队里的标本干员（键带四位编号）→ 标题显示完整名字（异构体不能混成一张脸）
      const nm = (isSpec || isSpecimenKey(k)) ? String(k) : cleanName(k);
      const op = (isSpec ? ((specFind(v, k) || {}).rec || {}) : ((v[source] || {})[k] || {}));
      const p = op.污染 || {};
      const field3 = (obj, keys3) => (obj && typeof obj === 'object')
        ? keys3.map((f) => f + '：' + (obj[f] || '未记录')).join('；') : '未记录';
      const expKeys = (obj) => (obj && typeof obj === 'object') ? Object.keys(obj) : [];
      const narr = '<div class="ins-sec"><b>外貌特征</b><br>' + this._esc(field3(op.外貌特征, ['年龄', '身体特征', '服装描述'])) + '</div>'
        + '<div class="ins-sec"><b>色情设定</b><br>' + this._esc(field3(op.色情设定, ['敏感部位', '名器特点', '淫化表现'])) + '</div>'
        + '<div class="ins-sec"><b>对玩家的态度</b><br>' + this._esc(op.对玩家的态度 || '未知') + '</div>'
        + '<div class="ins-sec"><b>经历记录</b><br>'
        + (expKeys(op.经历记录).map((t) => '· ' + this._esc(t) + '：' + this._esc(op.经历记录[t] || '')).join('<br>') || '暂无记录')
        + '</div>';
      const num = '<div style="text-align:center;margin:2px 0 6px">'
        + '<span class="kv">去量化 <b>' + this._num(op.去量化) + '</b></span>'
        + '<span class="kv">量化 <b>' + this._num(op.量化) + '</b></span>'
        + '<span class="kv">痴愚 <b>' + this._num(op.痴愚) + '</b></span></div>'
        + '<div style="text-align:center;margin:6px 0">' + this._radarSVGLabeled([p.未来, p.过往, p.现实]) + '</div>';
      return '<div class="dt-card">'
        + '<div class="dt-top"><img src="' + opArt(k, isSpec ? this._specElite : artEliteOf(op)) + '" alt="">'
        + '<span class="dt-id"><span class="dt-name">' + this._esc(nm) + '</span>'
        + '<span class="dt-state">状态 <b>' + this._esc(op.状态 || '?') + '</b>　已晋升 <b>' + (op.已晋升 ? '是' : '否') + '</b></span></span></div>'
        + (isSpec
          ? '<div class="dt-arts"><button class="dt-art' + (this._specElite ? '' : ' on') + '" data-e="0">精一胸像</button>'
            + '<button class="dt-art' + (this._specElite ? ' on' : '') + '" data-e="1">精二胸像</button>'
            + '<button class="dt-btn" data-sp-rename="' + this._esc(k) + '" title="只改名字，编号固定">✎ 改名</button>'
            + '<span class="dt-arthint">标本库可临时查阅，默认精一</span></div>'
          : '')
        + '<div class="dt-tabs">'
        + '<div class="dt-tab' + (mode === 'narr' ? '' : ' on') + '" data-m="num">数值 / 三轴</div>'
        + '<div class="dt-tab' + (mode === 'narr' ? ' on' : '') + '" data-m="narr">叙事档案</div></div>'
        + '<div class="dt-body">' + (mode === 'narr' ? narr : num) + '</div></div>';
    },

    /**
     * 干员编队页（整页浏览器，带「晋升」入口）。
     * ⚠ 标本库**不**走这里了：它有自己的折叠树页（_renderSpecimenPage，见「时间线存档」段）。
     *    这个函数只服务「干员编队」，数据永远是扁平的一层（键 = 纯干员名）。
     */
    _renderOpBrowser(source) {
      const v = readVars(this.win);
      const bag = v[source] || {};
      const keys = Object.keys(bag).sort((a, b) => cleanName(a).localeCompare(cleanName(b), 'zh'));
      // 晋升入口：重玩模式下不显示（收服即活化，不需要晋升）
      const isReplayHome = this._replayOn();
      const extra = isReplayHome ? '' : '<button class="mini-btn" id="pg-promote">⬆ 晋升</button>';
      const subOut = isReplayHome
        ? (keys.length ? ('在编 ' + keys.length + ' 位　重玩模式：收服即活化，无需晋升') : '重玩模式：收服即活化，无需晋升')
        : (keys.length ? ('在编 ' + keys.length + ' 位') : '');
      const list = keys.length
        ? '<div class="du-grid">' + keys.map((k) => this._opCardHTML(k, bag[k] || {}, false, isSpecimenKey(k))).join('') + '</div>'
        : '<div class="pg-empty">编队为空。<br>出门探索时收服的干员会出现在这里。</div>';
      const pg = this._openPage(
        this._pageHeadHTML('▣ 干员编队', subOut, extra)
        + '<div class="pg-body">'
        + '<div class="pg-side ds-scroll" id="pg-side">' + this._opDetailHTML('', source, 'num') + '</div>'
        + '<div class="pg-main ds-scroll" id="pg-main">' + list + '</div>'
        + '</div>'
      );
      const side = pg.querySelector('#pg-side');
      let selKey = '';
      let selMode = 'num';
      const bindTabs = () => {
        side.querySelectorAll('.dt-tab').forEach((t) => {
          t.onclick = () => { selMode = t.dataset.m === 'narr' ? 'narr' : 'num'; paintSide(); };
        });
      };
      const paintSide = () => { side.innerHTML = this._opDetailHTML(selKey, source, selMode); bindTabs(); };
      // 点卡切换选中（再点同一张 = 取消选中，详情栏回到空态）
      pg.querySelectorAll('#pg-main .du-card').forEach((card) => {
        card.onclick = () => {
          selKey = (card.dataset.k === selKey) ? '' : card.dataset.k;
          pg.querySelectorAll('#pg-main .du-card').forEach((c) => c.classList.toggle('sel', c.dataset.k === selKey));
          paintSide();
        };
      });
      {
        const pb = pg.querySelector('#pg-promote');
        // 晋升是独立选择窗，z-index 高于整页 → 直接叠在上面即可，返回时重开编队页
        if (pb) pb.onclick = () => this._renderPromote();
      }
    },

    /**
     * 收藏品 / 蚀刻章卡：**图像简化掉** —— 用名称派生的确定性渐变色块 + 几何符号代替原图，
     * 只保留「名称 / 描述 / 值 / 标签」，排版按参考图的三列密集网格。
     */
    _colCardHTML(nm, c, isMedal) {
      let h = 0;
      for (let i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) % 360;
      const val = (c && c.值 != null && c.值 !== '') ? String(c.值) : '';
      const tag = (c && c.标签 != null && c.标签 !== '') ? String(c.标签) : '';
      const bg = 'linear-gradient(140deg,hsl(' + h + ',58%,64%),hsl(' + ((h + 42) % 360) + ',52%,44%))';
      return '<div class="cc-card' + (isMedal ? ' medal' : '') + '">'
        + '<span class="cc-icon" style="background:' + bg + '">' + (isMedal ? '◈' : '◆') + '</span>'
        + '<span class="cc-meta"><span class="cc-nm">' + this._esc(nm) + '</span>'
        + (c && c.描述 ? '<span class="cc-desc">' + this._esc(c.描述) + '</span>' : '')
        + '<span class="cc-foot">'
        + (val ? '<em class="cc-tag">值 ' + this._esc(val) + '</em>' : '')
        + (tag ? '<em class="cc-tag">标签 ' + this._esc(tag) + '</em>' : '')
        + '</span></span></div>';
    },

    _renderCollectPage() {
      const v = readVars(this.win);
      const cols = v['收藏品'] || {};
      const medals = v['蚀刻章'] || {};
      const ck = Object.keys(cols), mk = Object.keys(medals);
      const body = '<div class="pg-sec">🧺 收藏品（本局）</div>'
        + (ck.length
          ? '<div class="cc-grid">' + ck.map((nm) => this._colCardHTML(nm, cols[nm] || {}, false)).join('') + '</div>'
          : '<div class="pg-empty">本局暂无收藏品。</div>')
        + '<div class="pg-sec">🫙 蚀刻章（长线，跨局保留）</div>'
        + (mk.length
          ? '<div class="cc-grid">' + mk.map((nm) => this._colCardHTML(nm, medals[nm] || {}, true)).join('') + '</div>'
          : '<div class="pg-empty">暂无蚀刻章。</div>');
      this._openPage(this._pageHeadHTML('◆ 收藏品库', '收藏品 ' + ck.length + ' 件　蚀刻章 ' + mk.length + ' 枚', '')
        + '<div class="pg-body"><div class="pg-main ds-scroll">' + body + '</div></div>');
    },

    _openOverlay(innerHTML) {
      this._closeOverlay();
      const ov = this.win.document.createElement('div');
      ov.id = 'game-overlay';
      // z-index 高于整页浏览器（#game-page 为 460），保证整页打开时弹窗也压在它上面
      ov.style.cssText = 'position:fixed;top:var(--bar-h, 48px);left:0;right:0;bottom:28%;z-index:470;background:rgba(8,10,14,.55);display:flex;align-items:center;justify-content:center;';
      ov.onclick = (e) => { if (e.target === ov) this._closeOverlay(); };
      const box = this.win.document.createElement('div');
      box.className = 'panel-box';
      box.innerHTML = innerHTML;
      ov.appendChild(box);
      this.win.document.body.appendChild(ov);
      return box;
    },

    _closeOverlay() { const el = this.win.document.getElementById('game-overlay'); if (el) el.remove(); },

    openCollect() { this._renderCollectPage(); },

    openRoster(mode) {
      if (!this._promotePick) this._promotePick = new Set();
      if (mode === 'promote') this._renderPromote();
      else this._renderRoster();
    },

    _rosterCards(promoteMode) {
      const v = readVars(this.win);
      const roster = v['干员编队'] || {};
      const keys = Object.keys(roster);
      if (!keys.length) return '<div style="color:#9aa3b0;text-align:center;padding:14px">编队为空。</div>';
      return '<div class="op-grid">' + keys.map((k) => {
        const op = roster[k] || {};
        const promoted = !!op.已晋升;
        let cls = 'op-card';
        if (promoteMode) { if (promoted) cls += ' disabled'; else if (this._promotePick.has(k)) cls += ' promote-pick'; }
        return '<div class="' + cls + '" data-k="' + k + '"><img src="' + opAva(k) + '">'
          + '<span class="nm">' + cleanName(k) + '</span>'
          + (promoted ? '<span class="tag">已晋升</span>' : (op.状态 ? '<span class="tag">' + op.状态 + '</span>' : ''))
          + '</div>';
      }).join('') + '</div>';
    },

    /** 干员编队 = 整页浏览器（可晋升）；标本库另有自己的折叠树页（_renderSpecimenPage），不走这里。 */
    _renderRoster() { this._renderOpBrowser('干员编队'); },

    _renderPromote() {
      if (State.busyPhase === 'generating') return;        // 思考中禁止打开晋升选择
      const cost = this._promoteCost();
      const box = this._openOverlay('<h3>⬆ 晋升（仅一次 · ' + cost + ' 源石/人）</h3>'
        + '<div class="panel-row"><button class="mini-btn gold" id="ov-do">确认晋升</button><button class="mini-btn gray" id="ov-back">← 编队</button><button class="mini-btn gray" id="ov-close">关闭</button></div>'
        + '<div id="ov-cards">' + this._rosterCards(true) + '</div>'
        + '<div id="ov-tip" style="color:#9aa3b0;font-size: max(11px, calc(12px + var(--fs-d, 0px)));margin-top:8px">晋升消耗 ' + cost + ' 源石。晋升之后，她的力量将随新的故事重新写定。</div>');
      box.querySelector('#ov-do').onclick = () => this._doPromoteConfirm();
      // 返回编队：先收起选择窗（z-index 高于整页），再重开整页编队
      box.querySelector('#ov-back').onclick = () => { this._closeOverlay(); this._renderRoster(); };
      box.querySelector('#ov-close').onclick = () => this._closeOverlay();
      box.querySelectorAll('#ov-cards .op-card').forEach((el) => {
        if (el.classList.contains('disabled')) return;
        el.onclick = () => {
          const k = el.dataset.k;
          if (this._promotePick.has(k)) this._promotePick.delete(k);
          else this._promotePick.add(k);
          this._renderPromote();
        };
      });
    },

    /**
     * 晋升确认（**扣费唯一入口：只在前端扣**）
     *   - 只对"未晋升"干员收费：先按实际可晋升名单算钱，再扣，避免为已晋升者白扣（重复扣减 bug 根因之一）。
     *   - 单价 = 难度口径（默认 4 源石/人；难度4 起 5 源石/人）。
     *   - 战报明确声明"费用已由前端扣完"，并要求 AI 不得改动淫堕源石。
     */
    _doPromoteConfirm() {
      // 重玩模式：收服即活化，不需要也不允许晋升（按钮已解禁但逻辑兜底）
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      if (this._replayOn()) { this._uiAlert('重玩模式不需要晋升：这里收服的干员一开始就是活化阶段。', '晋升'); return; }
      if (State.busyPhase === 'generating') return;        // 思考中禁止晋升（扣费+标记变量）
      if (!this._promotePick || !this._promotePick.size) { this.win.alert('请先点选要晋升的干员。'); return; }
      const cost = this._promoteCost();
      const v = readVars(this.win);
      const roster = v['干员编队'] || {};
      const stones = Number((v['玩家资源'] || {}).淫堕源石) || 0;
      // 只统计真实可晋升者（已晋升者不计费、不重复标记）
      const keys = [...this._promotePick].filter((k) => roster[k] && !roster[k].已晋升);
      if (!keys.length) { this.win.alert('所选干员均已晋升过，无需再晋升。'); return; }
      const need = keys.length * cost;
      if (stones < need) { this.win.alert('源石不足：晋升共需 ' + need + '（' + keys.length + ' 人 × ' + cost + '），当前 ' + stones + '。'); return; }
      const done = [];
      let paid = 0;
      writeVars(this.win, (d) => {
        if (!d['干员编队']) d['干员编队'] = {};
        if (!d['玩家资源']) d['玩家资源'] = {};
        // 二次校验（防面板打开期间变量被改写）：按真实落库名单结算
        const paidKeys = keys.filter((k) => d['干员编队'][k] && !d['干员编队'][k].已晋升);
        paid = paidKeys.length * cost;
        d['玩家资源'].淫堕源石 = Math.max(0, (Number(d['玩家资源'].淫堕源石) || 0) - paid);
        const promList = d['玩家资源'].已晋升干员 = d['玩家资源'].已晋升干员 || [];
        paidKeys.forEach((k) => {
          const op = d['干员编队'][k];
          // 前端只做"晋升已发生"的标记 + 扣费，不改任何数值（数值归 AI 全权维护，避免重复修改）
          op.已晋升 = true;
          if (!promList.includes(k)) promList.push(k);
          done.push(cleanName(k));
        });
      });
      this._promotePick.clear();
      this._recomputeLongPool();
      this.refreshStats();
      this._closeOverlay();
      if (!done.length) { this.win.alert('所选干员均已晋升过，未扣费。'); return; }
      const after = Number((readVars(this.win)['玩家资源'] || {}).淫堕源石) || 0;
      this.win.alert('晋升完成：' + done.join('、') + '\n源石 -' + paid + '（' + done.length + ' 人 × ' + cost + '），当前 ' + after + '。');
      const report = '晋升已生效：' + done.map((n) => '<' + n + '>').join('、') + '。'
        + '前端已扣费 ' + paid + ' 源石（' + done.length + ' 人 × ' + cost + ' 源石/人），余额 ' + after + '。淫堕源石 不再变动。'
        + '禁止再对 淫堕源石 做任何加减。'
        + '据此改写其档案与数值，展开对应剧情。';
      setTimeout(() => Engine._sendAsUser(this.win, this._sys(report)), 200);
    },

    /** （原「检视弹窗」已并入整页浏览器的左详情栏，见 _opDetailHTML；此方法不再单独存在。） */


    /** 长期池面板（地图常驻，只读展示；含雷达） */
    _longPanelHTML() {
      const v = readVars(this.win);
      const lp = v['_长期总池'] || { 污染: { 未来: 0, 过往: 0, 现实: 0 }, 去量化: 0 };
      const p = lp.污染 || {};
      const arr = [p.未来, p.过往, p.现实];
      const known = Number((v['玩家资源'] || {}).所知) || 0;
      return '<div class="long-panel" id="long-panel"><h4>长期池（已削后）</h4>'
        + '<div style="text-align:center">' + this._radarSVG(arr) + '</div>'
        + '<div>污染 未 ' + this._num(arr[0]) + ' / 过 ' + this._num(arr[1]) + ' / 现 ' + this._num(arr[2]) + '</div>'
        + '<div>去量化 ' + this._num(lp.去量化) + ' ｜ 所知 ' + known + '</div></div>';
    },

    _ensureLongPanel() {
      const el = this.win.document.getElementById('long-panel');
      if (!el && State.currentStatus === 'map_navigation') {
        const main = this.win.document.getElementById('main-content');
        if (main) main.insertAdjacentHTML('beforeend', this._longPanelHTML());
      } else if (el && State.currentStatus === 'map_navigation') {
        el.outerHTML = this._longPanelHTML();
      }
    },

    /**
     * 常驻右下角三轴雷达面板内容（所知 / 去量化 / 三轴）。
     * - 节点外（地图）：显示"削减后 + 常驻收藏品加成"的最终值（长期池），不含时效收藏品；
     * - 节点内：在长期池基础上再叠加"时效收藏品（标签=年份）"显示最终值。
     */
    _radarPanelHTML() {
      const v = readVars(this.win);
      const inNode = State.currentStatus === 'event_node';
      let axes = null;
      if (inNode) {
        try { axes = this._computeNodeAxes().axes; } catch (e) { axes = null; }
      }
      if (!axes) {
        const lp = v['_长期总池'] || { 污染: { 未来: 0, 过往: 0, 现实: 0 }, 去量化: 0 };
        const p = lp.污染 || {};
        axes = { 未来: Number(p.未来) || 0, 过往: Number(p.过往) || 0, 现实: Number(p.现实) || 0 };
      }
      const deq = Number((v['_长期总池'] || {}).去量化) || 0;
      const known = Number((v['玩家资源'] || {}).所知) || 0;
      // 战斗节点：叠加敌方红色三维（优先已建档敌方库；否则节点预设面板 axes）
      let enemyArr = null;
      let enemyTxt = '';
      if (inNode) {
        try {
          const ni = v['$切片'] || {};
          const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : {};
          const type = nd.type || State.nodeType || '';
          const isCombat = ['作战', '紧急作战', '险路恶敌'].includes(type);
          if (isCombat) {
            const enemyName = ni.$当前敌方 || '';
            let ep = null;
            const card = enemyName ? (v['敌方库'] || {})[enemyName] : null;
            if (card && card.污染) {
              ep = { 未来: Number(card.污染.未来) || 0, 过往: Number(card.污染.过往) || 0, 现实: Number(card.污染.现实) || 0 };
            } else if (nd.preset && nd.preset.axes) {
              ep = { 未来: Number(nd.preset.axes[0]) || 0, 过往: Number(nd.preset.axes[1]) || 0, 现实: Number(nd.preset.axes[2]) || 0 };
            }
            if (ep) {
              enemyArr = [ep.未来, ep.过往, ep.现实];
              enemyTxt = '<div class="rp-enemy" style="text-align:center;margin-top:2px;color:#ff8f8f;font-size: max(11px, calc(11px + var(--fs-d, 0px)))">敌方 '
                + this._num(ep.未来) + ' / ' + this._num(ep.过往) + ' / ' + this._num(ep.现实) + '</div>';
            }
          }
        } catch (e) {}
      }
      return '<div class="radar-panel" id="radar-panel"><h4>三轴雷达</h4>'
        + '<div style="text-align:center">' + this._radarSVGLabeled([axes.未来, axes.过往, axes.现实], enemyArr, this.body.classList.contains('ui-compact')) + '</div>'
        + '<div class="rp-nums" style="text-align:center;margin-top:2px">去量化 <b style="color:#fff">' + this._num(deq) + '</b> ｜ 所知 <b style="color:#fff">' + this._num(known) + '</b></div>'
        + enemyTxt + '</div>';
    },

    /** 创建/刷新常驻雷达面板：进出节点（地图/事件）都显示，其余状态隐藏。
     *  同时开关 body.radar-on —— 让聊天记录在雷达常驻期间始终让出右侧 212px 让位带。 */
    _ensureRadarPanel() {
      const doc = this.win.document;
      if (!doc) return;
      const show = State.currentStatus === 'map_navigation' || State.currentStatus === 'event_node';
      try { this.body.classList.toggle('radar-on', show); } catch (e) {}
      const old = doc.getElementById('radar-panel');
      if (!show) { if (old) old.remove(); return; }
      const html = this._radarPanelHTML();
      if (old) { old.outerHTML = html; } else {
        const tmp = doc.createElement('div');
        tmp.innerHTML = html;
        const node = tmp.firstChild;
        if (node) doc.body.appendChild(node);
      }
      // 雷达刚重建/换高 → 诡意行商的「确认购买」按钮要按新矩形重贴一次（它就是盖在雷达上的那块）
      try { this._syncShopBuyBtnPos(); } catch (e) {}
    },

    _escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); },

    /** 节点主目标（原定角色）的干净名：优先 AI 声明的 行动.原定目标，其次节点遭遇名，再兜底 切片.$原定角色 */
    _mainTargetName(nd) {
      const v = readVars(this.win);
      const declared = String(((v['行动'] || {}).原定目标) || '').trim();
      const named = (nd && nd.encounter && nd.encounter.name) || (v['$切片'] || {}).$原定角色 || '';
      return cleanName(declared || named || '');
    },

    /** 当前节点"遭遇/目标角色"的名字串（进节点口径 + AI 中途改写的当前对手），供蚀刻章判定用。
     *  多来源拼成一个串再"含词"判断：`$当前敌方` 由 AI 写（可能中途换人），不能只认进节点那一个。 */
    _encounteredNameBlob() {
      try {
        const v = readVars(this.win);
        const sl = v['$切片'] || {};
        const nd = (sl.$nodeData && typeof sl.$nodeData === 'object') ? sl.$nodeData
          : ((State.currentNodeData && typeof State.currentNodeData === 'object') ? State.currentNodeData : {});
        const names = [sl.$当前敌方, sl.$原定角色, nd.encounter && nd.encounter.name, nd.preset && nd.preset.name];
        try { names.push(this._mainTargetName(nd)); } catch (e) {}
        // 每个名字都过 normName（与 hasNamed 同一标准），判定关键词时不会因全角/标点漏配
        return names.filter(Boolean).map((s) => normName(cleanName(String(s)))).filter(Boolean).join('|');
      } catch (e) { return ''; }
    },

    /** 编队里是否存在"名字含任一关键词"的干员（编队键由 AI 写，键名容错匹配）。
     *  两侧都过 normName（去掉空白/引号/括号、破折号统一、转小写），故全角或带标点也认。 */
    _rosterHasKeyword(keywords) {
      try {
        const list = Array.isArray(keywords) ? keywords : [keywords];
        const r = readVars(this.win)['干员编队'] || {};
        return Object.keys(r).some((k) => {
          const nk = normName(cleanName(k));
          return !!nk && list.some((kw) => { const nkw = normName(kw); return !!nkw && nk.includes(nkw); });
        });
      } catch (e) { return false; }
    },

    /**
     * 蚀刻章授予（幂等）：按 ETCH_RULES 逐条判条件 —— **已有此章直接跳过**，缺则落盘 + 弹窗告知。
     * 调用点：① _enterNode（遭遇当场）；② _handleAiReply（编队由 AI 写变量，回复后兜底）；
     *        ③ _restoreGameState（重开窗口时补齐，防止"关着窗口达成条件"漏发）。
     * 变量结构：蚀刻章[名] = { 描述, 标签 }；蚀刻章属长线数据，跨局保留（见 _resetRunScopedDraft）。
     */
    _syncEtchBadges() {
      try {
        // 重玩模式：纯剧情体验，不产出任何收益 → 不发章（否则"遭遇某角色"就会白送蚀刻章）
        if (this._replayOn()) return [];
        const v = readVars(this.win);
        const owned = (v['蚀刻章'] && typeof v['蚀刻章'] === 'object') ? v['蚀刻章'] : {};
        const hit = [];
        const blob = this._encounteredNameBlob();
        ETCH_RULES.forEach((rule) => {
          if (hasNamed(owned, rule.name)) return;                       // 已有此章 → 不触发
          const eks = ETCH_ENCOUNTER_KEYWORD[rule.name];
          // blob 已经过 normName；关键词这一侧也过一遍，两侧同一标准才比较
          if (eks && (Array.isArray(eks) ? eks : [eks]).some((kw) => { const nkw = normName(kw); return !!nkw && blob.includes(nkw); })) { hit.push(rule); return; }
          const rks = ETCH_ROSTER_KEYWORD[rule.name];
          if (rks && this._rosterHasKeyword(rks)) { hit.push(rule); return; }
        });
        if (!hit.length) return [];

        writeVars(this.win, (d) => {
          const m = d['蚀刻章'] = (d['蚀刻章'] && typeof d['蚀刻章'] === 'object') ? d['蚀刻章'] : {};
          hit.forEach((rule) => {
            // 二次幂等：读变量与写变量之间，AI 可能刚把同一枚章写进去
            if (m[rule.name]) return;
            m[rule.name] = { 描述: rule.描述 || '', 标签: '' };
          });
        });
        this.refreshStats();
        this._uiAlert('获得蚀刻章：\n\n'
          + hit.map((r) => '◈ ' + r.name + (r.描述 ? '\n　　' + r.描述 : '')).join('\n\n')
          + '\n\n（长线收藏，跨局保留；可在「收藏品库」查看）', '蚀刻章');
        return hit.map((r) => r.name);
      } catch (e) {
        console.warn('[集成战略] 蚀刻章判定失败：', e && e.message);
        return [];
      }
    },
    /** 主目标是否已收服入编队（编队存在 cleanName 相同的干员） */
    _mainTargetRecruited(nd) {
      const t = this._mainTargetName(nd);
      if (!t) return false;
      const v = readVars(this.win);
      return Object.keys(v['干员编队'] || {}).some((k) => cleanName(k) === t);
    },
    /** 「离开节点」统一门控（与顶部按钮 3336 同一口径）：
     *  作战类节点收服主目标前不可离开；无主目标/已收服/非作战 → 可离开。
     *  供顶部按钮与"多一事不如少一事"离开选项共用。 */
    _nodeCanLeave() {
      try {
        const v = readVars(this.win);
        const ni = v['$切片'] || {};
        const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : {};
        const type = nd.type || State.nodeType || '';
        const combat = ['作战', '紧急作战', '险路恶敌'].includes(type);
        const targetName = this._mainTargetName(nd);
        const recruited = this._mainTargetRecruited(nd);
        return !combat || recruited || !targetName;
      } catch (e) { return true; }
    },
    /** AI 回复后刷新"战斗门"（_handleAiReply 调用）：
     *  ① 离开卡：主目标入编队（通关）后补出，未通关不渲染；
     *  ② 设基底按钮：作战节点收服前锁定，主目标入编队后解锁（与离开同口径 _nodeCanLeave）。 */
    _updateNodeLeaveGate() {
      this._ensureLeaveCard();
      this._syncBaseGateBtn();
    },

    /** 「主战干员」按钮（id 仍是 drop-base）的锁定同步：**只在重玩模式锁定**。
     *  作者拍板：「有激活时间线时才锁，没有激活时间线时开放」。
     *  ⚠ 因此这里**不再**吃 `_nodeCanLeave()` 的战斗门 ——
     *    旧行为「作战节点收服主目标前锁定设基底（防作战中途改基底/逃逸）」已按此要求移除。
     *    若日后要恢复那个战斗门，把 locked 改回 `replay || !this._nodeCanLeave()`。
     *  另注：AI 思考中（body.is-generating）按钮仍会被 CSS 变暗并屏蔽点击，那是生成期锁，与重玩无关。 */
    _syncBaseGateBtn() {
      try {
        const btn = this.win.document.getElementById('drop-base');
        if (!btn) return;
        const replay = this._replayOn();
        btn.disabled = replay;
        btn.classList.toggle('gate-locked', replay);
        btn.title = replay ? '重玩模式：主战干员已锁定' : '选择主战干员';
      } catch (e) {}
    },

    /** 重玩模式相关按钮的锁定同步（顶栏熔断 / 首页入口在 _renderHome 里另外处理）。 */
    _syncReplayLocks() {
      try {
        const doc = this.win.document;
        const replay = this._replayOn();
        const em = doc.getElementById('emergency-btn');
        if (em) {
          em.disabled = replay;
          em.classList.toggle('gate-locked', replay);
          em.title = replay ? '重玩模式：紧急熔断已锁定（请用「🫙 标本室 → 保存并禁用」退出重玩）' : '放弃本局并重置进度';
        }
        this._syncBaseGateBtn();
      } catch (e) {}
    },

    /** 当前是否应在右侧选项栏渲染「离开节点」合成卡（伪装成普通选项）：
     *  仅节点视图、非诡意行商、且未被战斗门锁住（主目标未收服 → 不出现）时渲染。 */
    _showLeaveCard() {
      try {
        if (State.currentStatus !== 'event_node') return false;
        const ni = (readVars(this.win)['$切片'] || {});
        const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : {};
        const type = (nd && nd.type) || State.nodeType || '';
        if (type === '诡意行商') return false;   // 诡意行商例外：只走顶端按钮，不出离开卡
        return this._nodeCanLeave();
      } catch (e) { return false; }
    },

    /** 在选项栏末尾追加「离开节点」合成卡：普通 .opt-card 外观（伪装），
     *  两次点击语义与正文选项一致（展开→确认）；
     *  确认走 _pickActionOption 拦截（isLeaveOption 命中）→ _leaveNode，预填充/终局逻辑零改动；
     *  收束态（$锁定）输入已锁死，_pickActionOption 的守卫会拦，需直连 _leaveNode。 */
    _appendLeaveCard(rail) {
      if (!rail) return;
      const b = this.win.document.createElement('button');
      b.className = 'opt-card';
      b.setAttribute('data-leave-card', '1');
      b.title = '离开当前节点';
      b.innerHTML = '离开节点';
      b.onclick = () => {
        const ex = rail.querySelector('.opt-card.expanded');
        if (ex && ex === b) {
          // 第二击：确认（展开态与正文选项互斥）
          if (this._nodeLocked()) { if (State.busyPhase === 'generating') return; this._leaveNode(); return; }
          this._pickActionOption({ title: '离开节点', desc: LEAVE_OPTION_DESC });
          return;
        }
        if (ex) ex.classList.remove('expanded');
        b.classList.add('expanded');
      };
      rail.appendChild(b);
    },

    /** 确保右侧选项栏存在「离开节点」卡（节点内常驻口径）：
     *  门控见 _showLeaveCard；选项栏已存在（有正文选项）则在末尾补卡、缺省时只建这一张卡；
     *  战斗未通关 / 诡意行商 / 非节点视图下什么都不做。
     *  入口：switchView(event_node)、_parseActionOptions、_updateNodeLeaveGate。 */
    _ensureLeaveCard() {
      if (!this._showLeaveCard()) return;
      try {
        let rail = this.win.document.getElementById('option-rail');
        if (!rail) {
          rail = this.win.document.createElement('div');
          rail.id = 'option-rail';
          this.win.document.body.appendChild(rail);
        }
        if (!rail.querySelector('.opt-card[data-leave-card]')) {
          this._appendLeaveCard(rail);
          // 作战类节点：从"不能离开"变成"可以离开"的这一刻 = 打完/收服完成 → 播一次任务完成条
          try { this._playMissionDoneOnce(); } catch (e) {}
        }
        this.body.classList.add('has-option-rail');
      } catch (e) {}
    },

    // ============================================================================
    // 【诡意行商：多选商品 + 确认购买（唯一改动范围＝诡意行商节点）】
    //   · 其它节点：正文选项「点一次展开 → 再点确认发送」（单发，见 _parseActionOptions）。
    //   · 诡意行商：正文选项＝商品，**多选**——点一次勾上、再点一次取消；不展开、不单发。
    //     发送统一由「确认购买」按钮承担，该按钮整块盖在右下角三轴雷达上（实测矩形，全尺寸覆盖，
    //     底色全不透明 → 雷达在购物期间完全不可见）。
    //   · 「离开节点」（HUD 顶端按钮）仍是两步：点选 → 再点执行；与商品勾选**互斥**（见 _shopPickLeave）。
    //   · 状态一律存在 DOM 的 class 上（.shop-picked / .shop-leave-picked），不写变量：
    //     每收到一条 AI 回复 _parseActionOptions 会整栏重建，勾选自然归零（新一轮商品重新待选）。
    //   · 唯一的例外是「已提交」待机态 Router._shopPending（纯会话内存）：提交后按钮不撤，
    //     只切文案等行商回应 —— 按钮必须一直在，否则它一撤，底下的三轴雷达就露出来了。
    // ============================================================================

    /** 当前是否正处「诡意行商」节点（唯一开启多选购物口径的节点类型） */
    _shopNodeNow() {
      try {
        if (State.currentStatus !== 'event_node') return false;
        const ni = readVars(this.win)['$切片'] || {};
        const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : {};
        const type = (nd && nd.type) || State.nodeType || '';
        return type === '诡意行商';
      } catch (e) { return false; }
    },

    /** 选项栏里已勾选的商品（按栏内顺序 = 正文编号顺序），元素上挂的 __shopItem 即解析出的 {n,title,desc} */
    _shopPickedItems() {
      try {
        const rail = this.win.document.getElementById('option-rail');
        if (!rail) return [];
        const out = [];
        rail.querySelectorAll('.opt-card.shop-picked').forEach((el) => { if (el.__shopItem) out.push(el.__shopItem); });
        return out;
      } catch (e) { return []; }
    },

    /** 清空全部商品勾选（互斥用：选中「离开节点」时调用） */
    _shopClearPicks() {
      try {
        const rail = this.win.document.getElementById('option-rail');
        if (rail) rail.querySelectorAll('.opt-card.shop-picked').forEach((el) => el.classList.remove('shop-picked'));
      } catch (e) {}
      this._shopRefreshBuyCaption();
    },

    /** 清掉「离开节点」的选中态（互斥用：勾选任意商品时调用） */
    _shopClearLeavePick() {
      try {
        const lv = this.win.document.getElementById('node-leave-btn');
        if (lv) lv.classList.remove('shop-leave-picked');
      } catch (e) {}
    },

    /** 「离开节点」按钮点击（诡意行商专用口径）。
     *  @returns {boolean} true = 本次点击只是"选中"，调用方应 return（不要离开）；
     *                     false = 先前已选中，本次是第二击 → 调用方继续执行离开。 */
    _shopPickLeave() {
      this._shopClearPicks();   // 互斥：选中离开 → 取消全部商品勾选
      try {
        const lv = this.win.document.getElementById('node-leave-btn');
        if (!lv) return false;
        if (lv.classList.contains('shop-leave-picked')) { lv.classList.remove('shop-leave-picked'); return false; }
        lv.classList.add('shop-leave-picked');
        return true;
      } catch (e) { return false; }
    },

    /** 商品卡片点击（诡意行商专用）：勾选 ⇄ 取消勾选；与「离开节点」互斥 */
    _shopToggleItem(el) {
      if (!el) return;
      if (State.busyPhase === 'generating') return;   // 思考中不许改购物车（与 .opt-card 的生成期锁同口径）
      if (this._nodeLocked()) return;
      const picked = el.classList.toggle('shop-picked');
      // 互斥：勾上商品的这一刻取消「离开节点」的选中态；取消勾选不动离开选中态（两者本来就不可能同时选中）
      if (picked) this._shopClearLeavePick();
      this._shopRefreshBuyCaption();
    },

    /** 刷新「确认购买」按钮上的件数文案与空态（无勾选时变灰，但依旧可点——点了给提示） */
    _shopRefreshBuyCaption() {
      try {
        const btn = this.win.document.getElementById('shop-buy-btn');
        if (!btn) return;
        const n = this._shopPickedItems().length;
        const pending = !n && !!this._shopPending;   // 已提交、等行商回应
        btn.classList.toggle('shop-empty', n === 0);
        const cap = btn.querySelector('.sb-cap');
        const sub = btn.querySelector('.sb-sub');
        if (cap) cap.textContent = n ? ('确认购买 · ' + n + ' 件') : (pending ? '已提交' : '确认购买');
        if (sub) sub.textContent = n
          ? '共 ' + n + ' 件待结账 · 点此提交'
          : (pending ? '行商正在点货…' : '先点选商品（可多选，再点取消）');
      } catch (e) {}
    },

    /** 把「确认购买」按钮贴到三轴雷达的实测矩形上（同位置同尺寸 → 雷达被整块盖住、不可见）。
     *  用 fixed + left/top/width/height 写入 inline style：不受 .radar-panel 各种媒体查询影响，
     *  雷达换高/换宽/切密度档后重贴一次即可（调用点：_ensureShopBuyBtn、_ensureRadarPanel、_galLayout）。 */
    _syncShopBuyBtnPos() {
      let btn = null;
      try { btn = this.win.document.getElementById('shop-buy-btn'); } catch (e) { return; }
      if (!btn) return;
      let r = null;
      try {
        const radar = this.win.document.getElementById('radar-panel');
        if (radar && radar.getBoundingClientRect) {
          const q = radar.getBoundingClientRect();
          if (q && q.width > 8 && q.height > 8) r = q;   // 视口退化（0×0）时不采用，走兜底
        }
      } catch (e) {}
      const st = btn.style;
      if (r) {
        // floor/ceil：宁可多盖 1px，也绝不在雷达边缘留出一条能看见雷达的缝
        st.left = Math.floor(r.left) + 'px';
        st.top = Math.floor(r.top) + 'px';
        st.width = Math.ceil(r.width) + 'px';
        st.height = Math.ceil(r.height) + 'px';
        st.right = 'auto'; st.bottom = 'auto';
      } else {
        // 兜底：与 .radar-panel 同一套位置口径（雷达尚未渲染时按钮仍可用、仍在右下角）
        st.left = 'auto'; st.top = 'auto';
        st.right = '8px'; st.bottom = '0';
        st.width = 'calc(var(--right-col) - 16px)';
        st.height = '132px';
      }
    },

    /** 建/刷「确认购买」按钮（诡意行商专用；挂 body 而非 #option-rail —— rail 自带 overflow 裁切） */
    _ensureShopBuyBtn() {
      try {
        const doc = this.win.document;
        let btn = doc.getElementById('shop-buy-btn');
        if (!btn) {
          btn = doc.createElement('button');
          btn.id = 'shop-buy-btn';
          btn.type = 'button';
          btn.title = '把已选中的商品一次性提交给行商';
          btn.innerHTML = '<span class="sb-cap">确认购买</span><span class="sb-sub">先点选商品（可多选，再点取消）</span>';
          btn.onclick = () => this._shopConfirmBuy();
          doc.body.appendChild(btn);
        }
        this._syncShopBuyBtnPos();
        this._shopRefreshBuyCaption();
      } catch (e) { console.warn('[集成战略] 确认购买按钮渲染失败：', e && e.message); }
    },

    _removeShopBuyBtn() {
      try {
        const b = this.win.document.getElementById('shop-buy-btn');
        if (b && b.parentNode) b.parentNode.removeChild(b);
      } catch (e) {}
    },

    /**
     * 「确认购买」：把本次勾选的**全部**商品作为一条 user 消息发出（诡意行商里唯一的发送出口）。
     * 消息附带给 AI 的结算契约（作者口径）：
     *   检查 <user> 要求购买哪些商品 → 检查玩家资源 → 核对总额；
     *   总额不够 → 安排**拒绝全部操作**的剧情（不允许部分成交/赊账/先给货），
     *   并在正文末尾以 <action_options> **重新提供全部商品**待选。
     * 与 _pickActionOption 同一条发送出口（_commitPlayerMessage），预填充/变奏锁/战报口径零改动。
     */
    _shopConfirmBuy() {
      if (this._nodeLocked()) return;
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      if (State.busyPhase === 'generating') return;
      if (!this._shopNodeNow()) return;
      const picks = this._shopPickedItems();
      if (!picks.length) {
        // 已提交过、正等行商回应 → 不再弹窗（避免玩家连点时被埋一堆提示）
        if (this._shopPending) return;
        this._uiAlert('还没有选中任何商品。\n\n先点选想买的商品（可多选，再点一次即取消），再点「确认购买」提交。', '诡意行商');
        return;
      }
      const input = this.win.document.getElementById('chat-input');
      const draft = input ? (input.value || '').trim() : '';
      const list = picks.map((it, i) => '  ' + (i + 1) + '. ' + it.title + (it.desc ? '（' + it.desc + '）' : '')).join('\n');
      let msg = draft ? `(玩家输入: ${draft})\n` : '';
      msg += `【选择】购买：${picks.map((it) => it.title).join('、')}`;
      // 结算契约（<eventp> 隐藏区，只在给 AI 的原文里，玩家气泡看不到）
      msg += '\n' + this._sys('玩家在诡意行商处确认购买以下商品（共 ' + picks.length + ' 件）：\n' + list
        + '\n\n【结算要求】① 先检查<user>要求购买哪些商品；② 再检查玩家资源（淫堕源石 / 精液 / 所知 等）'
        + '与各商品的实际标价，核对本次全部所选商品的总额；'
        + '③ 若玩家资源总额**不足以支付全部所选商品**，则安排「拒绝全部操作」的剧情：'
        + '不接受部分成交、不允许赊账或以物抵账、不先给货，本次任何商品都不交付；'
        + '并在正文末尾**重新提供本节点的全部商品**待选（价格、数量照旧；' + OPT_FORMAT_HINT + '）'
        + '④ 若总额足够，则收下全部款项并把所选商品一次性交付给玩家。');
      if (State.pendingLeaveNote) { msg = State.pendingLeaveNote + '\n' + msg; State.pendingLeaveNote = ''; }
      if (input) input.value = '';
      // 下单即收摊：清勾选、清离开选中态、撤掉商品卡（防生成期间的误触与重复下单）。
      // ⚠ 「确认购买」按钮**不撤**：它常驻在右下角盖住三轴雷达，撤掉会让雷达在等待期间又露出来；
      //    只切到「已提交」待机态，等新一批商品渲染（或离开节点）再恢复。
      this._shopClearPicks();
      this._shopClearLeavePick();
      const r = this.win.document.getElementById('option-rail');
      if (r && r.parentNode) r.parentNode.removeChild(r);
      this.body.classList.remove('has-option-rail');
      this._shopPending = true;
      this._shopRefreshBuyCaption();
      this._commitPlayerMessage(msg);
    },

    /** 设置主战干员（原「基底」，变量仍是 `_探索进程.$基底干员`）：
     *  写入 $基底干员；该干员尚无数值则用池内预设补上，已有则保留真实值；随后重算长期池。 */
    _setBaseOperator(key) {
      if (State.busyPhase === 'generating') return;        // 思考中禁止换主战干员（会写变量/重算池）
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      if (!key) return;
      const p = POOL_BY_NAME[cleanName(key)];
      writeVars(this.win, (d) => {
        if (!d['干员编队']) d['干员编队'] = {};
        const op = d['干员编队'][key];
        if (op && (op.污染 == null || op.去量化 == null) && p) {
          op.去量化 = p.quant; op.量化 = 0; op.痴愚 = 0;
          op.污染 = { 未来: p.rev[0], 过往: p.rev[1], 现实: p.rev[2] };
        } else if (op) { op.量化 = op.量化 || 0; op.痴愚 = 0; }
        if (!d['_探索进程']) d['_探索进程'] = {};
        d['_探索进程'].$基底干员 = key;
      });
      this._recomputeLongPool();
      this.refreshStats();
      State.entryRoster = null; // 主战干员变更 → 下一次进节点重新快照
      // 节点确认栏里的那个「主战干员」框与顶栏按钮共通：改完立刻原地刷新头像与名字
      try { this._refreshNodeConfirmBase(); } catch (e) {}
    },

    /** 三轴基底选择界面：列在编干员 → 点选即设为基底 */
    _openBasePicker() {
      if (State.busyPhase === 'generating') return;        // 思考中禁止打开主战干员选择
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      if (!this._nodeCanLeave()) {                          // 战斗门：作战节点收服前锁定（与离开同口径）
        try { if (this.win && this.win.alert) this.win.alert('作战节点需先了结此间主目标'); } catch (e) {}
        return;
      }
      const v = readVars(this.win);
      const roster = v['干员编队'] || {};
      const keys = Object.keys(roster);
      const base = (v._探索进程 && v._探索进程.$基底干员) || '';
      if (!keys.length) { this._uiAlert('编队为空，先收编或选择主战干员。', '主战干员'); return; }
      const cards = keys.map((k) => {
        const op = roster[k] || {};
        const p = op.污染 || {};
        const isBase = k === base;
        return '<div class="op-card' + (isBase ? ' promote-pick' : '') + '" data-k="' + k + '">'
          + '<img src="' + opAva(k) + '">'
          + '<span class="nm">' + this._esc(this._nodeDisplayName(k)) + (isBase ? ' ·主战' : '') + '</span>'
          + '<span class="tag">' + this._num(p.未来 || 0) + ' / ' + this._num(p.过往 || 0) + ' / ' + this._num(p.现实 || 0) + '</span>'
          + '</div>';
      }).join('');
      const box = this._openOverlay('<h3>主战干员</h3>'
        + '<div style="color:#cfd8e3;font-size: max(11px, calc(12px + var(--fs-d, 0px)));line-height:1.6;margin-bottom:8px">她将以自己的污染，为整支队伍定下基调。</div>'
        + '<div class="op-grid">' + cards + '</div>'
        + '<div class="panel-row"><button class="mini-btn gray" id="ov-close">关闭</button></div>');
      box.querySelector('#ov-close').onclick = () => this._closeOverlay();
      box.querySelectorAll('.op-card').forEach((el) => {
        el.onclick = () => { this._setBaseOperator(el.dataset.k); this._closeOverlay(); };
      });
    },

    /**
     * 计算"本节点最终三轴"：长期池（已含长期型收藏品+层衰减）→ 再叠加本节点时间点型收藏品对撞。
     * 返回 { year, axes, applied }，供战报与进节点动画共用。不涉及敌我判定。
     */
    _computeNodeAxes() {
      const v = readVars(this.win);
      const ni = v['$切片'] || {};
      const year = Number(ni.$当前时间点) || 1094;
      const lp = v['_长期总池'] || { 污染: { 未来: 0, 过往: 0, 现实: 0 }, 去量化: 0 };
      const t = { 未来: Number((lp.污染 || {}).未来) || 0, 过往: Number((lp.污染 || {}).过往) || 0, 现实: Number((lp.污染 || {}).现实) || 0 };
      const cds = v['收藏品'] || {};
      const applied = [];
      Object.keys(cds).forEach((nm) => {
        const c = cds[nm] || {};
        const type = this._collectibleType(c);
        const val = Number(c.值) || 0;
        if (type === '年份对撞') {
          // 年份对撞：年份 = 新写法 c.年份（或旧写法 数字标签）；轴由本节点年份对撞决定
          const yRaw = (c.年份 != null && String(c.年份).trim() !== '') ? c.年份 : c.标签;
          const yS = String(yRaw == null ? '' : yRaw).trim();
          if (/^-?\d+(\.\d+)?$/.test(yS)) {
            const y2 = Number(yS);
            const axis = y2 < year ? '过往' : (y2 > year ? '未来' : '现实');
            t[axis] += val;
            ['未来', '过往', '现实'].forEach((o) => { if (o !== axis) t[o] -= val / 2; });
            applied.push({ 名: nm, 类型: '时间点·' + axis, 值: val });
          }
          return;
        }
        if (type === '三维固定') {
          // 三维固定型（轴固定）：长期池已并入，本节点只记录，不再重复叠加。
          // 兼容旧"标签=三轴名"单轴长期型：同样只记录。
          const s = String(c.标签 == null ? '' : c.标签).trim();
          if (s === '未来' || s === '过往' || s === '现实') applied.push({ 名: nm, 类型: '长期·' + s, 值: val });
          else applied.push({ 名: nm, 类型: '三维固定（长期已并入）', 值: null });
          return;
        }
        // 纯叙事：无数值效果
      });
      return { year, axes: t, applied };
    },

    /**
     * 敌我裁定：逐轴对比我方最终三轴 ≥ 敌方该轴抗性 → 该轴优势；优势达标则敌方量化减半，否则双方原值硬碰硬（我方不减半）；
     * 差>0胜 / <0负 / =0相持掷骰。
     * 难度修正（纯前端叠加，逐级生效）：
     *   - 难度5：须同时有 ≥2 轴优势才算"优势达标"；
     *   - 难度6：「所知」对我方战力的加减反转 —— 所知为正 → 倒扣我方去量化；所知为负 → 增益。
     */
    _evalBattle(t, deqBase, known, enemy) {
      const ePoll = (enemy && enemy.污染) || {};
      const lv = this._diffLevel();
      const winAxes = ['未来', '过往', '现实'].filter((ax) => t[ax] >= (Number(ePoll[ax]) || 0));
      const need = lv >= 5 ? 2 : 1;                 // 难度5：必须双轴优势
      const advantage = winAxes.length >= need;
      let deq = Number(deqBase) || 0;
      let eq = Number(enemy && enemy.量化) || 0;
      if (advantage) eq = eq / 2;   // 优势达标 → 敌方量化减半
      // 优势未达标：双方原值硬碰硬，我方去量化不减半（按拍板设计，非"失败惩罚"）
      const kn = Number(known) || 0;
      const knownDelta = lv >= 6 ? -kn : kn;       // 难度6：所知效果反转
      const diff = (deq + knownDelta) - (eq + (Number(enemy && enemy.痴愚) || 0));
      const verdict = diff > 0 ? '胜' : (diff < 0 ? '负' : '相持·掷骰');
      return { winAxes, deq, eq, diff, verdict, ePoll, advantage, need, knownDelta, knownReverse: lv >= 6 };
    },

    /**
     * 战斗裁定（面向 AI）：一行弱点轴 + **一句六态判定** + **一句战败代价**。
     *
     *  只发前端算完的结论，不发推导过程：
     *    · 不发「我方去量化 / 直战差 / 削弱后差」—— 中间值，AI 不复算；我方数值本来就在 _长期总池 里，
     *      世界书写明"勿照抄数字"，印一遍等于递抄稿。
     *    · 不发「削弱需要 N 条优势轴」—— N 是从难度档位算来的（难度5 = 2 轴），发出去等于泄露难度，
     *      与"难度对 AI 隐藏"的裁定冲突；门槛已经含在六态判定里。
     *    · **每一条判定都带「战败代价」**（作者口径）：不能只写在必败分支里 —— 玩家在"可胜/相持"的
     *      战局里也可能输（选错、硬拼、弃权），AI 必须手上有"输了扣多少"的权威数字才敢落账。
     *      N 按**节点类型**给（险路恶敌 隐藏层 30 / 险路恶敌 3 / 紧急作战 2 / 其它 1），
     *      不期而遇转作战也走这里（系数 1），因此"所有作战判定战报"口径统一。
     *    · 必败两态（可削弱但削后不胜 / 不可削弱且不能胜）额外说明「献祭吞噬」收场：
     *      **正面陈述结果**（核心生命 -N、对方仍被收服、归零即失败），不用否定式。
     *  第 5、6 态（不可削弱·胜负相持 / 不可削弱·不能战胜）在 _evalBattle 里确实存在，必须补齐，否则漏判。
     */
    _battleVerdictText(b, deqBase, enemy, known) {
      const r2 = (x) => this._round2(x);
      const eqE = Number(enemy && enemy.量化) || 0;
      const fo = Number(enemy && enemy.痴愚) || 0;
      const kn = Number(b.knownDelta) || 0;
      const deq = Number(deqBase) || 0;
      const dLose = r2((deq + kn) - (eqE + fo));          // 直战（不削弱）
      const dWin = r2((deq + kn) - ((eqE / 2) + fo));     // 削弱成功后
      const weakAxes = (b.winAxes && b.winAxes.length) ? b.winAxes.join('、') : '';
      // 战败代价系数（**唯一口径，按当前节点类型**）：
      //   险路恶敌（隐藏层）30 / 险路恶敌 3 / 紧急作战 2 / 其它（作战、不期而遇转作战）1
      const nodeType = (() => {
        try {
          const nd = ((readVars(this.win)['$切片'] || {}).$nodeData) || {};
          return (nd && nd.type) || State.nodeType || '作战';
        } catch (e) { return '作战'; }
      })();
      const sac = (() => {
        if (nodeType === '险路恶敌') return (Number(State.currentLayer) || 1) >= HIDDEN_LAYER ? 30 : 3;
        if (nodeType === '紧急作战') return 2;
        return 1;   // 作战 / 不期而遇转作战
      })();
      // ⚠ 每一条判定都要带这一行：玩家在"可胜/相持"的战局里也可能输，AI 手里必须有权威扣血量才敢落账。
      const lossTxt = '战败代价：核心生命 -' + sac + '（' + nodeType + '系数）；核心生命归零即本局失败。';
      // 必败两态的收场句（献祭吞噬；正面陈述结果，不用否定式）
      const sacTxt = '这一战赢不了：以献祭吞噬收场。' + lossTxt + 'ta仍会被收服。';
      const head = '弱点轴：' + (weakAxes || '无') + '。';
      let judge;
      if (b.advantage && dLose > 0) {
        // 有弱点轴，且不削弱也打得过：削弱无必要
        judge = '判定：可以削弱，但不需要削弱也能战胜。\n直接交锋即可，胜后收服。\n' + lossTxt;
      } else if (b.advantage && dWin > 0) {
        // 有弱点轴，直战不胜、削弱后胜：必须先削
        judge = '判定：可以削弱，且削弱后可以战胜。\n直接硬拼会败：先削弱，再决胜。胜后收服。\n' + lossTxt;
      } else if (b.advantage) {
        // 有弱点轴，但削到位也打不过
        judge = '判定：可以削弱，但削弱后也不能战胜。\n' + sacTxt;
      } else if (dLose > 0) {
        // 没有弱点轴，但纯战力够
        judge = '判定：不可削弱，但不需要削弱也可战胜。\n直接交锋即可，胜后收服。\n' + lossTxt;
      } else if (dLose === 0) {
        judge = '判定：不可削弱，胜负相持。\n按掷骰结果推进。\n' + lossTxt;
      } else {
        // 没有弱点轴，且战力不够
        judge = '判定：不可削弱，且不能战胜。\n' + sacTxt;
      }
      return head + '\n' + judge;
    },

    /**
     * 计算"开局修正"（纯增量，可精确回退）——难度效果 + 已实现的分队效果。
     * 只返回"额外buff数值"，不直接改玩家资源；应用/回退由 _applyRunDifficulty 负责。
     * 换难度、换分队都只是换一组修正，因此**切换不会累积**（每次先回退旧修正再加新修正）。
     */
    _runDelta(lv, squad) {
      const ctx = diffCtx(lv);
      const d = { 核心生命: 0, 淫堕源石: 0, 精液: 0 };
      const notes = [];
      if (lv >= 1) { d.核心生命 -= 4; notes.push('难度' + lv + '：核心生命 -4'); }
      if (squad === '后勤分队') { d.淫堕源石 += 2; d.精液 += 20; notes.push('后勤分队：源石 +2、精液 +20'); }
      return { delta: d, notes, ctx };
    },

    /**
     * 应用「开局设置」（难度 + 分队 + 短对局）——经济模型（唯一权威口径，**只有一条路径**）：
     *
     *   【重置】通关 / 失败 / 熔断 / 存档退出 → `_resetRun()` 把经济复位为初始值（10 / 0 / 0 / 0）；
     *           **每次「确认并出发」开新局前也会先 `_resetRunScopedDraft()` 复位一次**（见 prep-start）。
     *   【加】  复位之后再调本函数 → `玩家资源 += 本局这一份 难度/分队 修正`。
     *
     *   ⚠ 铁律：
     *   1) **只有"确认并出发"才加**：主城里改难度/分队/短对局都只更新内存暂存值，绝不碰经济；
     *      唯一的落值点就是这里（唯一调用点 = prep-start）。
     *   2) **不维护任何"基线/修正账本"**：因为进来之前经济一定刚被复位成初始值，
     *      所以"初始值 + 一份 delta"本身就是幂等的；反复点出发也只是"再复位一次再重算"，永不累积。
     *   3) 下钳 0：修正本身不会把任何一项压成负数（核心生命 10−4=6；源石/精液只会加）。
     *
     *   `$短对局` 也在这里落值（同属"开局面板设置"，与难度同一套时序）：
     *   它**不影响经济**，但必须在开新局这一刻写死 —— 层序/敌池/衰减/隐藏关概率全部读它，
     *   中途改会让已生成的地图与 `$收藏品获得层` 账本口径错位。故界面上只在出发前能切。
     */
    _applyRunDifficulty() {
      if (State.busyPhase === 'generating') return;        // 思考中禁止「确认并出发」（会写经济/修正）
      const lv = Number.isFinite(State.pendingDifficulty) ? State.pendingDifficulty : this._effDiff();
      const squad = State.pendingSquad || '后勤分队';
      // 短对局：内存点过用内存，否则沿用变量里上次的选择（与主城滑块的显示口径一致）
      const shortRun = (State.pendingShortRun != null) ? !!State.pendingShortRun : this._shortRunOn();
      const { delta, notes, ctx } = this._runDelta(lv, squad);
      writeVars(this.win, (d) => {
        const diff = d['$难度'] = (d['$难度'] && typeof d['$难度'] === 'object') ? d['$难度'] : {};
        diff.档位 = lv;
        diff.分队 = squad;
        // 难度2：每层三轴削减 20% → 25%（系数，无累积问题）
        d['$衰减档'] = ctx.decay;
        // 短对局：纯前端区开关（层序/敌池/衰减次数/隐藏关概率都读它）
        d['$短对局'] = shortRun;

        const prog = d['_探索进程'] = (d['_探索进程'] && typeof d['_探索进程'] === 'object') ? d['_探索进程'] : {};
        // 晋升计价：难度 → 单价 → 整句报价。与 diffCtx() 同源，AI 只读不改、也不自己算。
        prog._晋升花费 = promoteSentence(ctx.promoteCost);

        // ── 经济：唯一一次「加修正」─────────────────────────────────────────────
        //   进来之前 prep-start 已经调用过 _resetRunScopedDraft()（玩家资源 = 10/0/0/0），
        //   所以这里只要 += 这一份 delta。无账本、无回退、也没有第二次写入的可能。
        const res = d['玩家资源'] = (d['玩家资源'] && typeof d['玩家资源'] === 'object') ? d['玩家资源'] : {};
        const num = (x) => Number(x) || 0;
        res.核心生命 = Math.max(0, num(res.核心生命) + num(delta.核心生命));
        res.淫堕源石 = Math.max(0, num(res.淫堕源石) + num(delta.淫堕源石));
        res.精液 = Math.max(0, num(res.精液) + num(delta.精液));
      });
      return { 档位: lv, 分队: squad, 备注: notes, ctx, delta };
    },

    /** 进节点展示叠加过程：年份 / 生效收藏品 / 最终三轴；作战节点额外给出敌方数值对比 + 优势轴 + 判定 */
    _showNodeStackOverlay() {
      // 作战伪加载页期间不播：先记一笔，加载结束后由 _flushDeferredPresentation 补播
      if (State.loadingActive) { State.pendingStack = true; return; }
      try {
        const v = readVars(this.win);
        const ni = v['$切片'] || {};
        const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : {};
        const type = nd.type || State.nodeType || '';
        const combat = ['作战', '紧急作战', '险路恶敌'].includes(type);
        const { year, axes: t, applied } = this._computeNodeAxes();
        // 敌方：优先已建档卡（敌方库）；否则用节点预设面板（System 报告的预设）
        const enemyName = ni.$当前敌方 || '';
        let enemy = null;
        const card = enemyName ? (v['敌方库'] || {})[enemyName] : null;
        if (card && card.量化 != null) {
          enemy = { name: enemyName, 量化: card.量化, 痴愚: card.痴愚, 污染: card.污染 || {}, fromCard: true };
        } else if (nd.preset) {
          const p = nd.preset;
          enemy = { name: p.name, 量化: p.quant, 痴愚: p.folly, 污染: { 未来: p.axes[0], 过往: p.axes[1], 现实: p.axes[2] }, fromCard: false };
        }
        let battle = null;
        if (combat && enemy) {
          battle = this._evalBattle(t, Number((v['_长期总池'] || {}).去量化) || 0, Number((v.玩家资源 || {}).所知) || 0, enemy);
        }
        const doc = this.win.document;
        // 顶掉规则：进节点战报若正好在屏上，让位给更新的内容（作者拍板：战报没几个人看）
        const chronUp = doc.getElementById('chron-overlay');
        if (chronUp) chronUp.remove();
        const old = doc.getElementById('stack-overlay');
        if (old) old.remove();
        const el = doc.createElement('div');
        el.id = 'stack-overlay';
        el.className = 'stack-overlay';
        let i = 0;
        const rowDelay = () => (0.3 + i * 0.22).toFixed(2);
        const rowsHtml = [];
        rowsHtml.push('<div class="stack-row" style="animation-delay:' + rowDelay() + 's">节点年份：<b>' + year + '</b></div>'); i++;
        if (applied.length) {
          applied.forEach((a) => { rowsHtml.push('<div class="stack-row" style="animation-delay:' + rowDelay() + 's">' + this._escapeHtml(a.类型) + ' · ' + this._escapeHtml(a.名) + ' <b>+' + this._num(a.值) + '</b></div>'); i++; });
        } else {
          rowsHtml.push('<div class="stack-row" style="animation-delay:' + rowDelay() + 's">本节点无收藏品叠加</div>'); i++;
        }
        rowsHtml.push('<div class="stack-row" style="animation-delay:' + rowDelay() + 's">最终三轴：未来 <b>' + this._num(t.未来) + '</b> / 过往 <b>' + this._num(t.过往) + '</b> / 现实 <b>' + this._num(t.现实) + '</b></div>'); i++;
        if (battle) {
          const ep = battle.ePoll;
          rowsHtml.push('<div class="stack-row" style="animation-delay:' + rowDelay() + 's">敌方「' + this._escapeHtml(enemy.name) + '」：量化 <b>' + this._num(enemy.量化) + '</b> · 痴愚 <b>' + this._num(enemy.痴愚) + '</b> · 三抗 <b>' + this._num(ep.未来) + '</b>/<b>' + this._num(ep.过往) + '</b>/<b>' + this._num(ep.现实) + '</b></div>'); i++;
          rowsHtml.push('<div class="stack-row" style="animation-delay:' + rowDelay() + 's">我方 去量化 <b>' + this._num((v['_长期总池'] || {}).去量化) + '</b> · 所知 <b>' + this._num((v.玩家资源 || {}).所知) + '</b>　裁定差 <b>' + this._num(battle.diff) + '</b></div>'); i++;
          rowsHtml.push('<div class="stack-row" style="animation-delay:' + rowDelay() + 's">优势轴：<b>' + (battle.winAxes.length ? battle.winAxes.join('/') : '无') + '</b>　'
            + (battle.advantage ? '可削弱' : '不可削弱') + '　判定：<b>' + battle.verdict + '</b></div>');
        }
        el.innerHTML = '<div class="stack-box">'
          + '<div class="stack-title stack-row" style="animation-delay:.06s">进入「' + this._escapeHtml(type || '节点') + '」</div>'
          + (combat && !enemy ? '<div class="stack-row" style="animation-delay:.2s;color:#ffb4a0">敌方卡缺失·请 AI 先建档</div>' : '')
          + rowsHtml.join('');
        doc.body.appendChild(el);
        setTimeout(() => { const n = doc.getElementById('stack-overlay'); if (n) n.classList.add('hide'); }, 3800);
        setTimeout(() => { const n = doc.getElementById('stack-overlay'); if (n) n.remove(); }, 4500);
      } catch (e) {}
    },

    /** 选中开局/基底干员时：把她（池内预设）的真实数值实时写入 干员编队（我方口径：去量化=quant、污染=反转三轴、痴愚丢弃）。
     *  开局基底 = "唯一替换"语义：先清空本局编队，只保留新选中的基底（否则重复抽随机干员会把历次 roll 全部累积进 干员编队）。 */
    _syncBaseCard(key) {
      if (!key) return;
      const p = POOL_BY_NAME[cleanName(key)];
      writeVars(this.win, (d) => {
        // 清空旧 roll / 旧选择，只留当前基底（重 roll = 清除替换）
        d['干员编队'] = {};
        const op = d['干员编队'][key] = makeEmptyOperator('开局之缘');
        if (p) {
          op.去量化 = p.quant;
          op.量化 = 0;
          op.痴愚 = 0;
          op.污染 = { 未来: p.rev[0], 过往: p.rev[1], 现实: p.rev[2] };
        }
        op.已晋升 = op.已晋升 || false;
      });
    },

    _enterNode(type, colIdx, nodeIdx) {
      if (State.busyPhase === 'generating') return;        // 思考中禁止进入新节点（会改切片/进度）
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      this._closeNodeConfirm(true);                             // 进节点必然收起确认栏
      const col = colIdx != null ? colIdx : 0;
      const seq = nodeIdx != null ? nodeIdx : 0;
      const nodeId = `L${State.currentLayer}C${col}N${seq}`;
      // 干员池：前端决定"该层该节点类型出现谁"；数值为预设，随报告交 AI 建档。
      // 遭遇规则：安全屋=无目标角色（纯休整）；不期而遇=50% 无目标角色；其余节点照常抽取。
      // 去重口径：抽取前按**编队键精确匹配**排除已收服（见下方 pick；标本后缀键不挡本体，防"全身都是第一层的人"）。
      let preset = null;
      const layer = State.currentLayer;
      const poolLayer = this._poolForLayer(layer);
      // 干员开关筛网：先滤掉开关表禁用的名字再抽（各池下限 5/2 已由拒绝逻辑保底）。
      // 编队精确去重：**键精确匹配**（防本局已收服的干员被重复刷出；标本后缀键 ≠ 本体名，
      // 如"阿米娅_3f"不挡住本体"阿米娅"，允许标本与本体重合出场）。
      // 回退只在**启用集**内进行：全被携带 → 容忍重复（防池被收空后节点无遭遇）；
      // 绝不回退到含禁用者的原池 —— 保持"禁用=永不参与随机"的硬契约（见模块2.7）。
      const carried = new Set();
      try { Object.keys((readVars(this.win)['干员编队']) || {}).forEach((n) => carried.add(n)); } catch (e) {}
      const pick = (list) => {
        const enabled = (list || []).filter((e) => isNameEnabled(e && e.name));
        let candidates = enabled.filter((e) => !carried.has(e && e.name));
        if (!candidates.length) candidates = enabled;   // 全被携带 → 容忍重复
        return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
      };
      // 隐藏关：只在「不期而遇」进节点时掷**一次**，结果冻结进 $切片.$隐藏关。
      // 先扫一遍收藏品置位，保证"该族已到手"的判断用的是最新状态（族内互斥/前置条件都读它）。
      // ⚠ 防冲突：**隐藏层（第六层）内不再掷隐藏关**。第六层本身就是已经进入的那条隐藏世界线，
      //   再在它的「不期而遇」里触发第二条（例如顺手补一件「大群交触手」）会造成两条世界线重叠，
      //   还会顺手激活固定 boss 规则。层号是唯一判据，与事件表内容无关。
      let hiddenEv = null;
      if (type === '不期而遇' && layer < HIDDEN_LAYER) {
        this._syncHiddenFlags();
        hiddenEv = this._rollHiddenEvent();
      }
      if (type === '安全屋') {
        preset = null;                                    // 安全屋：没有目标角色，只是休整据点
      } else if (hiddenEv) {
        preset = pick(poolLayer.非作战);                   // 命中隐藏关 → **强制抽一个目标**（"被同化的角色"才存在）
        if (!preset) preset = pick(poolLayer.作战);        // 非作战池空时兜底
      } else if (type === '不期而遇' && Math.random() < 0.5) {
        preset = null;                                    // 不期而遇：50% 概率无目标角色
      } else if (type === '作战' || type === '紧急作战') {
        preset = pick(poolLayer.作战);
      } else if (type === '险路恶敌') {
        preset = this._pickDanger(layer);   // 隐藏层固定 希尔达；3/5 层命中收藏品规则则固定；否则原随机 boss 池
      } else if (type === '诡意行商') {
        preset = null;   // 诡意行商：独立于时空外的纯叙事交易节点（普瑞赛斯在世界书固定出现），无目标角色、不抽敌方
      } else {
        preset = pick(poolLayer.非作战); // 闲暇娱乐等仍按原规则抽取
      }
      const encounter = preset ? { name: preset.name } : null;
      // 年代只在此（进节点）掷一次：按遭遇角色查她本人的随机区间；无目标角色回退默认区间。
      // 节点内触发战斗 / 额外收服一律复用 $切片.$当前时间点，不再重掷。
      const year = rollPersonYear(encounter ? encounter.name : '');
      // 【少年时代修正】非长生种少年时代更弱：修正后的预设立即成为本节点唯一口径——
      // 进 $切片.$nodeData 持久化（重开窗口也在）、随 System 报告交 AI 建 敌方库 卡，全程无人再回填原设。
      if (preset) preset = applyYouthWeakness(preset, encounter ? encounter.name : '', year);
      const v = readVars(this.win);
      const base = (v._探索进程 && v._探索进程.$基底干员) || Object.keys(v['干员编队'] || {})[0] || '';
      const node = { type, layer, col, seq, 节点编号: nodeId, encounter, preset };
      State.currentNodeData = node;
      State.nodeType = type;
      State.gameOpened = true;
      // 进节点快照当前编队（离开时若被意外清空则回填，防丢干员）
      try { State.entryRoster = JSON.parse(JSON.stringify(v['干员编队'] || {})); } catch (e) { State.entryRoster = null; }
      // 节点内最小存档（防重开丢失时间点/敌方）+ 变奏字段初始化（原定角色/收服基线）
      const rosterKeys = Object.keys(v['干员编队'] || {});
      // 第5层 boss：进节点时就把"打完是结算还是进第六层"冻结进 $切片。
      // 目的：战斗中 AI 改写收藏品/蚀刻章不会让结局改判；重开后随切片一致恢复。
      const 终局分支 = (type === '险路恶敌' && layer === 5) ? (this._hiddenGateMet() ? 'hidden' : 'finish') : '';
      this._persistNodeSlice({
        active: true, status: 'event_node', nodeData: node, year, 敌方: encounter ? encounter.name : '',
        原定: encounter ? encounter.name : '', 基线: rosterKeys, 终局分支,
        隐藏关: hiddenEv ? hiddenEv.id : '',
      });
      // 行动通道复位（AI 的"额外探索/原定目标"只在节点内有效）
      writeVars(this.win, (d) => { const a = d['行动'] = (d['行动'] && typeof d['行动'] === 'object') ? d['行动'] : {}; a.额外探索 = false; a.原定目标 = ''; });
      // 消费缓存的"离开上一节点"前缀（若有）
      const pendingNote = State.pendingLeaveNote || '';
      State.pendingLeaveNote = '';
      const entryName = cleanName(base) || '（孤身）';
      const presetTxt = preset
        ? '\n（预设面板：量化 ' + preset.quant + ' 痴愚 ' + preset.folly + ' 三抗 未来 ' + preset.axes[0] + '/过往 ' + preset.axes[1] + '/现实 ' + preset.axes[2]
          + '。写入「敌方库」档案并照此填数值。收服后转换：三维抗性→污染、量化→去量化、痴愚→丢弃。）'
        : '';
      // 对局导向（作战类节点）：在 AI 第一次剧情前就把我方/敌方最终数值、优势轴、判定发给它，便于提供引导性选项
      let guideTxt = '';
      if (['作战', '紧急作战', '险路恶敌'].includes(type) && preset) {
        try {
          this._recomputeLongPool(); // 刷新 _长期总池，再算本节点最终三轴
          const { axes: a2 } = this._computeNodeAxes();
          const vv = readVars(this.win);
          const enemy = { name: preset.name, 量化: preset.quant, 痴愚: preset.folly, 污染: { 未来: preset.axes[0], 过往: preset.axes[1], 现实: preset.axes[2] } };
          const bt2 = this._evalBattle(a2, Number((vv['_长期总池'] || {}).去量化) || 0, Number((vv.玩家资源 || {}).所知) || 0, enemy);
          const orient = bt2.verdict === '胜' ? '胜→交锋后收服' : (bt2.verdict === '负' ? '负→先削/周旋/交涉' : '相持→见机');
          guideTxt = '\n【对局导向】本节点最终三轴 未来' + this._round2(a2.未来) + '/过往' + this._round2(a2.过往) + '/现实' + this._round2(a2.现实)
            + '；敌方<' + preset.name + '>三抗 ' + this._round2(preset.axes[0]) + '/' + this._round2(preset.axes[1]) + '/' + this._round2(preset.axes[2])
            + '、量化 ' + preset.quant + '、痴愚 ' + preset.folly + '。'
            + '\n' + this._battleVerdictText(bt2, Number((vv['_长期总池'] || {}).去量化) || 0, enemy, Number((vv.玩家资源 || {}).所知) || 0)
            + '\n导向：' + orient + '。据此把握本节点走向，为玩家提供贴合优劣导向的选项。';
        } catch (e) { guideTxt = ''; }
      }
      // 无目标角色节点的战报适配：不报遭遇对象/不报预设面板，仅作轻量场景提示（具体剧情交由 AI 展开）
      const noTargetTxt = !encounter
        ? (type === '安全屋' ? '\n（安全屋，无目标角色。）' : '\n（本节点无目标角色。）')
        : '';
      // 收尾指令：命中隐藏关时**整句替换**（不是追加）—— 否则"给 2~4 个选项"会和"只能一个选项"打架。
      // 同时隐藏关不报"预设面板/对局导向"那套常规战斗口吻，改由隐藏关后缀统一交代。
      const tail = hiddenEv
        ? this._hiddenReportSuffix(hiddenEv)
        : ('\n据此展开本段剧情；' + OPT_FORMAT_HINT);
      // 新手建档战报（只有第一次通关前触发；可反复失败重开，每次新一局的第一个节点触发一次）：
      //   判定 = 本局第一个节点（确认并出发置真）&& 标本库为空（还没通关归档过任何干员 = 只能随机干员期）。
      //   作用 = 让 AI 用这一节点把「干员编队」里所有新手干员的一次性写全：清除占位、编造人设、年龄可破格。
      let noviceTxt = '';
      if (State.firstNodePending && !specCount(v)) {   // 标本库按时间线分组 → 用 specCount 数全库卡数
        noviceTxt = '\n（新手建档：标本库为空，本局携带均为随机邂逅的新手干员，档案多为「待发掘/待初始化」占位。'
          + '用变量更新标签（updatevariable/update 等）为「干员编队」中每名干员一次性补齐完整档案：'
          + '外貌特征（年龄/身体特征/服装描述）、色情设定、经历记录、对玩家的态度。'
          + '年龄可破格，不限正史。）';
      }
      // 开局修正战报（本局第一个节点、每局一次）：把玩家开局前跟普瑞赛斯谈定的"世界线修正"落进变量。
      //   · 与 noviceTxt **同一个 firstNodePending 门，但不依赖标本库是否为空** —— 老玩家也要能定桩；
      //   · 判定交给 AI 自己按语义回忆对话（**不写死标记串**），但**判定逻辑与句式必须清楚**：
      //     条件两句（她指定过修正？+ <user> 同意或未反对？）→ 是 / 否 两个分支，各一句话；
      //   · 与正文的先后不用强调：变量更新本来就在正文之后，这里只说"立刻写"，不说"先写再写正文"。
      let startFixTxt = '';
      if (State.firstNodePending) {
        startFixTxt = '\n（开局修正：普瑞赛斯是否在前文提到了开局关于「所知」与「剧情日志」的修正，并且 <user> 未作反对？\n'
          + '只要提到了：立刻写入变量 —— ① `玩家资源.所知` = 她指定的数值（她没提数值就跳过此项）；'
          + '② `剧情日志` 的 `-999999年` = 她指定的底层逻辑（详细和直白设定世界特色和角色应当如何表现, 并标注为[绝对遵守的世界底层设定]）。这条占用本节点"进节点"的那条日志名额，不再另加一条。\n'
          + '如果她未提及，或 <user> 反对：无视本句。）';
      }
      State.firstNodePending = false;   // 每局只消费一次
      // 诡意行商：独立于时空外的交易节点 —— 战报只写"进入<普瑞赛斯>的诡意行商节点"，
      // 不随机目标/年代/三轴战报，不写目标与年代类变量（普瑞赛斯已在世界书固定出现），购买可自由招募多名干员。
      const report = type === '诡意行商'
        ? (pendingNote ? pendingNote + '\n' : '') + this._sys('你进入了<普瑞赛斯>的诡意行商节点（' + nodeId + '）。' + noviceTxt + startFixTxt + tail)
        : (pendingNote ? pendingNote + '\n' : '') + this._sys('你携带着' + (base ? ('<' + entryName + '>') : '（孤身）') + '，进入「' + type + '」（' + nodeId + '）。'
          + (encounter ? '\n此间遭遇了 ' + year + ' 年的<' + encounter.name + '>。' : '')
          + (hiddenEv ? '' : (noTargetTxt + presetTxt + guideTxt))
          + noviceTxt
          + startFixTxt
          + tail);
      this.switchView('event_node');
      // 本节点的「任务完成」黑条每个节点只播一次：进节点先把标记清掉
      State.missionDoneKey = '';
      State.pendingMissionDone = false;
      // 作战类节点：**先**盖一层伪加载页（≈5.5s），再走下面所有"会自己播动画"的东西 ——
      // _showNodeStackOverlay / 日志播报在加载期间被压住，加载结束后由 _flushDeferredPresentation 补播。
      // ⚠ 只影响表现层：战报照旧在本次调用末尾立刻发出（AI 现在就开始跑）。
      if (isCombatNodeType(type)) {
        try { this._startNodeLoading(type, encounter ? encounter.name : ''); } catch (e) { console.warn('[集成战略] 加载页启动失败', e && e.message); }
      }
      this._showNodeStackOverlay();
      // 蚀刻章：遭遇当场判定（例：第一次遭遇「洁尔佩塔」→「内部爱」）
      this._syncEtchBadges();
      setTimeout(() => Engine._sendAsUser(this.win, report), 250);
    },

    _persistNodeSlice(sl) {
      writeVars(this.win, (d) => {
        const ni = d['$切片'] = (d['$切片'] && typeof d['$切片'] === 'object') ? d['$切片'] : {};
        const S = {
          $active: !!(sl && sl.active),
          $status: (sl && sl.status) || 'out_of_game',
          $nodeData: (sl && sl.nodeData) || null,
          $当前时间点: (sl && sl.year) || 1094,
          $当前敌方: (sl && sl.敌方) || '',
          $软硬: (sl && sl.软硬) || ni.$软硬 || '硬',
          $终局分支: (sl && sl.终局分支 != null) ? sl.终局分支 : (ni.$终局分支 || ''),
          $隐藏关: (sl && sl.隐藏关 != null) ? sl.隐藏关 : (ni.$隐藏关 || ''),
        };
        // 离开/收束：整段复位（含变奏相关字段）；否则仅接受显式给出的字段
        if (!sl || !sl.active) {
          S.$原定角色 = '';
          S.$收服基线 = [];
          S.$额外收服完成 = false;
          S.$变奏用尽 = false;
          S.$锁定 = false;
          S.$待定 = false;
          S.$终局分支 = '';
          S.$隐藏关 = '';   // 隐藏关标记是"本节点"的：离开即失效（随机已在进节点时用过一次）
        } else {
          if (sl.原定 !== undefined) S.$原定角色 = sl.原定;
          if (sl.基线 !== undefined) S.$收服基线 = sl.基线;
          S.$额外收服完成 = !!(sl && sl.额外收服完成);
          S.$变奏用尽 = !!(sl && sl.变奏用尽);
          S.$锁定 = !!(sl && sl.锁定);
          S.$待定 = !!(sl && sl.待定);
        }
        Object.keys(S).forEach((k) => { ni[k] = S[k]; });
      });
    },

    /**
     * 【指挥分队】离开作战节点 → 核心生命 +1（**唯一入口**，纯前端）。
     *  · 触发条件只用变量：`$难度.分队 === '指挥分队'`（分队互斥，同一时刻只有一个值）。
     *  · 只认节点类型 **作战 / 紧急作战 / 险路恶敌**；「不期而遇转对战」的节点类型仍是「不期而遇」，
     *    因此天然被排除 —— 这正是作者要的口径。
     *  · 幂等：只在 _leaveNode 里调用一次；通关（结算）那次不调用（随后整体复位，加了也会被清掉）。
     *  · 写变量后顺手告诉 AI"这 +1 是前端给的"，免得它也去加一遍（与晋升扣费同一套口径）。
     * @returns {number} 实际加了几点（0 = 没加）
     */
    _commandSquadLeaveBonus(nodeType) {
      try {
        const v = readVars(this.win);
        if (String(((v['$难度'] || {}).分队) || '') !== '指挥分队') return 0;
        if (!['作战', '紧急作战', '险路恶敌'].includes(String(nodeType || ''))) return 0;
        writeVars(this.win, (d) => {
          const res = d['玩家资源'] = (d['玩家资源'] && typeof d['玩家资源'] === 'object') ? d['玩家资源'] : {};
          res.核心生命 = Math.max(0, (Number(res.核心生命) || 0) + 1);
        });
        return 1;
      } catch (e) { return 0; }
    },

    _leaveNode() {
      const nd = State.currentNodeData;
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      const typeLabel = (nd && nd.type) || State.nodeType || '此节点';
      // 去向判定统一走 _resolveClear()（三态唯一口径）：普通/第3层 boss → 换层；
      // 第5层 boss 视冻结分支 → 结算或进第六层；第六层 boss → 结算。
      const out = this._resolveClear();
      const fin = out.kind === 'finish';
      if (fin || out.kind === 'enterHidden') State.pendingLeaveNote = ''; // 结算/进隐藏层都不接"回裂隙"前缀
      else if (!State.pendingLeaveNote) State.pendingLeaveNote = this._nodeLeaveNote(typeLabel);
      // 指挥分队：离开作战类节点 → 核心生命 +1。
      //   ⚠ 通关（fin）那次不加：随即整体复位经济，加了也会被清掉，只会让 AI 看到一次假回血。
      //     进隐藏层（enterHidden）不结算、只换层 → 要加。
      if (!fin && this._commandSquadLeaveBonus(typeLabel) > 0) {
        State.pendingLeaveNote = (State.pendingLeaveNote ? State.pendingLeaveNote + '\n' : '')
          + this._sys('指挥分队：本次离开作战节点，核心生命 +1（已由前端写入，你不需要再动 核心生命）。');
      }
      writeVars(this.win, (d) => { const a = d['行动'] = (d['行动'] && typeof d['行动'] === 'object') ? d['行动'] : {}; a.额外探索 = false; a.原定目标 = ''; });
      this._persistNodeSlice(null);
      this._resetNodeTransient();
      if (fin) {
        State.entryRoster = null; // 通关会合法清空编队并归档，无需恢复
        // 通关：**先定时间线编号**，标本与剧情都归入同一条时间线 → 主城
        //   · 编号在写入前就选好（_newTimelineId 只跟已有编号去重），两段归档共用它；
        //   · 即使本局一条剧情都没有，也会建出这条线——因为本次通关的活化干员已经按它入档了。
        const baseBefore = ((readVars(this.win)._探索进程 || {}).$基底干员) || '';
        let runTid = '';
        try {
          const vNow = readVars(this.win);
          const memNow = (vNow['$时间线记忆库'] && typeof vNow['$时间线记忆库'] === 'object' && !Array.isArray(vNow['$时间线记忆库'])) ? vNow['$时间线记忆库'] : {};
          runTid = this._newTimelineId(memNow);
        } catch (e) { runTid = ''; }
        if (!runTid) runTid = String(Date.now()).slice(-4);   // 兜底：绝不让标本因为"没编号"而丢失
        let archived = 0;
        try { archived = this._archiveRunToSpecimen(runTid) || 0; } catch (e) { console.warn('[集成战略] 通关归档失败', e && e.message); }
        State.currentLayer = 1;
        State.mapCache = null;
        // 通关 → 本局变量整体复位（经济 + 干员编队 + 地图 + 节点切片 + 收藏品 + 行动 + 长期池 + 基底干员）。
        // 玩家回到开局界面重选编队时一切必为初始值，之后「确认并出发」再叠加难度/分队修正 →【重置 → 叠加】循环。
        writeVars(this.win, (d) => {
          // 通关归档：本局剧情日志 → $时间线记忆库 的 `runTid` 那条（与标本库组号同号）。
          //   · archived > 0 → 强制用 runTid（哪怕本局没日志也要建出这条线，标本必须挂在它下面）；
          //   · archived = 0 → 只传 ''（旧口径：有日志才建线，两者都空就不留空行）。
          // ⚠ 必须在 _resetRunScopedDraft 之前（它会清空剧情日志）。
          try { this._archiveChronicleInto(d, archived > 0 ? runTid : ''); } catch (e) { console.warn('[集成战略] 剧情日志归档失败', e && e.message); }
          this._resetRunScopedDraft(d);
          d['_当前启用时间线'] = '';   // 通关走的是正常流程，顺手解除重玩闸（防御性）
          if (d['_全局资产']) d['_全局资产'].首次通关标记 = true;
        });
        State.nodeType = '';
        State.currentNodeData = null;
        this._resetPrepSelection();   // 内存侧同步复位（下次进编队界面从干净状态开始）
        this.switchView('out_of_game');
        // 结算战报：除了"恭喜通关"，必须把**本时间线的世界编号 = 角色名后缀**告诉 AI ——
        // 刚结算的这批人进了 标本库[runTid]，此后正文里提到她们要写成 <名字+runTid>，
        // 而本局内出现的敌方、以及没从标本库带出来的友方一律不带后缀。
        // ⚠ baseBefore 是编队键原文（可能就是 `阿米娅1234`），别拿 cleanName 把编号剥掉。
        const tidNote = (archived > 0 && String(runTid || '').trim())
          ? ('\n本时间线分配到的世界编号和角色名后缀为: ' + String(runTid).trim()
            + '。刚归档的这几位的完整名字就是「名字' + String(runTid).trim() + '」，'
            + '此后正文里提到她们一律写成 <名字' + String(runTid).trim() + '> / {名字' + String(runTid).trim() + '}'
            + '（如 <阿米娅' + String(runTid).trim() + '>）；带着同一个编号的不同世界线的她是不同的个体，可以同台。')
          : '';
        setTimeout(() => Engine._sendAsUser(this.win, this._sys(this._layerName(nd && nd.layer) + '终局已了，你与' + (baseBefore ? ('<' + baseBefore + '>') : '众人') + '的羁绊归于罗德岛。恭喜通关。' + tidNote)), 200);
        return;
      }
      // 防御性保底：非结算离开节点时，若编队被意外清空则回填进节点快照，防"离开作战节点后干员丢失"
      //（进隐藏层同样适用 —— 那是"局内换层"，绝不能把编队丢掉）
      try {
        const cur = readVars(this.win)['干员编队'] || {};
        if (!Object.keys(cur).length && State.entryRoster && Object.keys(State.entryRoster).length) {
          writeVars(this.win, (d) => { d['干员编队'] = JSON.parse(JSON.stringify(State.entryRoster)); });
        }
      } catch (e) {}
      State.entryRoster = null;
      if (out.kind === 'enterHidden') { this._enterHiddenLayer(); return; }
      this._advanceMap();
      this.switchView('map_navigation');
    },

    /**
     * 进入隐藏层（第六层）—— **局内换层，不是新局**：
     *   绝不调用 _archiveRunToSpecimen() / _resetRunScopedDraft()，否则编队、收藏品、
     *   长期池会被清空，第六层就没得打了。只换层号 + 换地图 + 落幂等标记。
     * 幂等：$探索进程.$隐藏层 落盘为 true；万一"离开"被重复触发，第二次直接回地图，
     *       不会重复生成地图或重复发战报。
     */
    _enterHiddenLayer() {
      try {
        const v = readVars(this.win);
        if ((v['_探索进程'] || {}).$隐藏层) { this.switchView('map_navigation'); return; }
        State.currentLayer = HIDDEN_LAYER;
        State.currentNodeData = null;
        State.nodeType = '';
        State.mapCache = null;
        const next = this._genMap();            // 第六层：固定单行 4 节点（见 HIDDEN_MAP_SEQUENCE），末级 险路恶敌
        State.mapCache = next;
        writeVars(this.win, (d) => {
          d['$地图状态'] = next;
          const p = d['_探索进程'] = (d['_探索进程'] && typeof d['_探索进程'] === 'object') ? d['_探索进程'] : {};
          p.$隐藏层 = true;
          p.$当前层数 = HIDDEN_LAYER;
          p.$当前位置 = '第1列';
          const s = d['$切片'] = (d['$切片'] && typeof d['$切片'] === 'object') ? d['$切片'] : {};
          s.$终局分支 = 'hidden';
        });
        this.switchView('map_navigation');
        // ⚠ 进隐藏层**不发任何战报、不触发回复**（作者拍板）。
        //   理由：说了就等于提前剧透——只要一提"末级首领固定<希尔达>"，AI 完全可能在第一个节点
        //   就把希尔达摆出来，甚至顺手写死结局。这里三件事本来都有各自的负责人，不需要这段战报：
        //     · 这是哪条世界线 → `$隐藏关` 拿到收藏品时已 f→t，世界线ejs 早已激活对应世界线条目；
        //     · 最终首领是谁   → 进那个节点时正常的「此间遭遇了 … 年的<希尔达>」，该出场时才出场；
        //     · 打完是否结算   → 前端 _resolveClear() 判定，AI 不必预知。
        //   顺带：蚀刻章名自此完全不出现在 AI 可见文本里，正合 0-2 裁定（章名不进提示词）。
        //   存档不受影响：switchView 里已经 _persistGameState。
      } catch (e) {
        console.warn('[集成战略] 进入隐藏层失败', e && e.message);
        this.switchView('map_navigation');
      }
    },

    /**
     * 【模块2.8 · 时刻重排】把 剧情日志 的键按 `年,月,日` 升序重排写回。
     *  · 幂等：顺序没变直接返回 false（不写变量，避免每轮无意义写入）；
     *  · 排序规则见 chronicleKeyParts / sortChronicleKeys：格式写错也能排（取键内最靠前的
     *    数字当年份兜底），一个数字都没有的键丢到最末；
     *  · 读 readVars（已剥 $meta），写回由 writeVars 重新注入 $meta。
     * @returns {boolean} 是否真的重排过
     */
    _sortChronicle() {
      try {
        const v = readVars(this.win);
        const log = v['剧情日志'];
        if (!log || typeof log !== 'object' || Array.isArray(log)) return false;
        const keys = Object.keys(log).filter(isChronicleEntryKey);
        if (keys.length < 2) return false;
        const sorted = sortChronicleKeys(keys);
        let same = true;
        for (let i = 0; i < keys.length; i++) { if (keys[i] !== sorted[i]) { same = false; break; } }
        if (same) return false;
        const next = {};
        sorted.forEach((k) => { next[k] = log[k]; });
        writeVars(this.win, (d) => { d['剧情日志'] = next; });
        return true;
      } catch (e) { return false; }
    },

    // ================= 剧情日志：变更检测 → 播报卡 → 时间轴页 =================
    //   数据源：AI 写 `剧情日志`（键＝泰拉历 `年,月,日`，值＝1~3 句）。世界书规定：
    //     · 埋坑 = 新增一条（insert）；
    //     · 收坑 = **改写同一条的值，键不变**（replace）→ 所以"同一个键的值变了"就是因果闭环合拢的那一刻，
    //       必须与"新增"分开播报（作者拍板：分两张卡）。
    //   前端只做三件事：比快照 → 排队弹卡 → 提供整页时间轴。绝不改写 AI 写的日志正文。

    /** 一条日志的值 → 纯文本（AI 只该写字符串；写坏成对象也兜住，绝不序列化活变量对象）。 */
    _chronicleVal(x) {
      if (x == null) return '';
      if (typeof x === 'string') return x;
      if (typeof x === 'number' || typeof x === 'boolean') return String(x);
      try { return JSON.stringify(x); } catch (e) { return String(x); }
    },

    /** 当前 剧情日志 的「键 → 纯文本」表，按世界历升序（与 _sortChronicle 同一排序口径）。 */
    _chronicleNow() {
      const v = readVars(this.win);
      const log = (v['剧情日志'] && typeof v['剧情日志'] === 'object' && !Array.isArray(v['剧情日志'])) ? v['剧情日志'] : {};
      const keys = sortChronicleKeys(Object.keys(log).filter(isChronicleEntryKey));
      const m = new Map();
      keys.forEach((k) => m.set(k, this._chronicleVal(log[k])));
      return m;
    },

    /**
     * 日志变更检查（唯一入口，可反复调用）：
     *   「键是新的」→ 新增剧情；「键在、值变了」→ 日志更新；没变化直接返回。
     *   因此 _sortChronicle 的重排（只改键序）、前端自己写回，都不会误弹。
     *   快照在比较前就先更新：即使后面入队/建卡失败，也不会下一轮又弹一遍（防重复）。
     */
    _checkChronicleUpdates() {
      try {
        const now = this._chronicleNow();
        const prev = State.chronicleFp;
        State.chronicleFp = now;
        if (!prev) return;                       // 首帧只建基线，不弹
        const items = [];
        now.forEach((val, k) => {                // Map 顺序 ＝ 已按世界历升序
          if (!prev.has(k)) items.push({ type: 'add', key: k, text: val });
          else {
            const old = prev.get(k);
            if (old !== val) items.push({ type: 'edit', key: k, old: old, text: val });
          }
        });
        if (items.length) this._enqueueChroniclePopups(items);
      } catch (e) { console.warn('[集成战略] 剧情日志变更检查失败：', e && e.message); }
    },

    /** 入队并启动播放（已在播就只追加，播完自然接着放；跨视图不打断 —— 作者要求"继续弹完"）。 */
    _enqueueChroniclePopups(items) {
      if (!items || !items.length) return;
      State.chronicleQueue = (State.chronicleQueue || []).concat(items);
      if (!State.chroniclePlaying) this._playChronicleQueue();
    },

    /** 串行播放：弹一张 → 等它淡出完 → 再弹下一张（作者要求：上一条过期了再弹下一条）。 */
    _playChronicleQueue() {
      // 作战伪加载页期间不播：把 playing 置回 false，加载结束后 _flushDeferredPresentation 会重启队列
      if (State.loadingActive) { State.chroniclePlaying = false; return; }
      const q = State.chronicleQueue || [];
      if (!q.length) { State.chroniclePlaying = false; return; }
      State.chroniclePlaying = true;
      const item = q.shift();
      let stay = CHRONICLE_POPUP.baseMs;
      try { stay = this._showChroniclePopup(item) || stay; } catch (e) {}
      // 停留 + 淡出 + 余量；建卡抛错也要继续走，绝不卡住队列
      setTimeout(() => this._playChronicleQueue(), Math.max(600, stay + CHRONICLE_POPUP.fadeMs + 200));
    },

    /**
     * 建一张播报卡，返回本卡停留毫秒。
     *  · 新增：普通宽度卡（「📜 新增剧情」+ 泰拉历 + 正文）。
     *  · 更新：**左右两块**「更新前 ➜ 更新后」，每块与新增卡正文同宽 → 宽度翻倍、高度不变（作者要求）。
     *  · 顶掉规则（作者拍板）：本卡出现时，更早的浮层（进节点战报／上一张日志卡）立刻让位。
     *  · 点击卡片 → 打开时间轴页并高亮这一条。
     */
    _showChroniclePopup(item) {
      const doc = this.win.document;
      const isEdit = item.type === 'edit';
      const chars = String(item.text || '').length + String(item.old || '').length;
      const stay = Math.min(CHRONICLE_POPUP.maxMs,
        CHRONICLE_POPUP.baseMs + Math.floor(chars / CHRONICLE_POPUP.perChars) * CHRONICLE_POPUP.stepMs);

      // 顶掉更早的浮层：战报没几个人看，日志卡才是要读的那张
      const oldStack = doc.getElementById('stack-overlay');
      if (oldStack) oldStack.remove();
      const oldChron = doc.getElementById('chron-overlay');
      if (oldChron) oldChron.remove();

      const date = this._escapeHtml(chronicleDateLabel(item.key));
      const body = isEdit
        ? '<div class="chron-pair stack-row" style="animation-delay:.22s">'
          + '<div class="chron-cell old"><span class="ccap">更新前</span>' + this._escapeHtml(item.old || '（空）') + '</div>'
          + '<div class="chron-arrow">➜</div>'
          + '<div class="chron-cell new"><span class="ccap">更新后</span>' + this._escapeHtml(item.text || '') + '</div>'
          + '</div>'
        : '<div class="chron-text stack-row" style="animation-delay:.22s">' + this._escapeHtml(item.text || '') + '</div>';

      const el = doc.createElement('div');
      el.id = 'chron-overlay';
      el.className = 'stack-overlay chron-overlay';
      el.innerHTML = '<div class="stack-box chron-box' + (isEdit ? ' wide' : '') + '">'
        + '<div class="stack-title stack-row" style="animation-delay:.05s">' + (isEdit ? '🖋 日志更新' : '📜 新增剧情')
        + '<span class="chron-tag">　泰拉历 ' + date + '</span></div>'
        + body
        + '<div class="chron-hint stack-row" style="animation-delay:.42s">点击此卡 → 打开历史时间轴</div>'
        + '</div>';
      const box = el.firstChild;
      if (box) box.onclick = () => {
        try { this._renderChroniclePage(item.key); } catch (e) {}
        try { el.remove(); } catch (e) {}
      };
      doc.body.appendChild(el);
      setTimeout(() => { const n = doc.getElementById('chron-overlay'); if (n) n.classList.add('hide'); }, stay);
      setTimeout(() => { const n = doc.getElementById('chron-overlay'); if (n) n.remove(); }, stay + CHRONICLE_POPUP.fadeMs + 200);
      return stay;
    },

    /**
     * 整页：本局历史时间轴（**只看本局 剧情日志**，不含 时间线记忆库 —— 作者拍板）。
     * 按泰拉历升序：早年在上、越往下越晚，与 _sortChronicle 完全同口径，
     * 所以页面顺序 == 变量重排后的真实顺序，不会出现"看着乱序"的割裂。
     * @param {string} [hiKey] 从播报卡点进来时的目标键：滚到该条并高亮。
     */
    _renderChroniclePage(hiKey) {
      const now = this._chronicleNow();
      const keys = Array.from(now.keys());
      const rows = keys.map((k) => '<div class="tl-item' + ((hiKey && k === hiKey) ? ' hi' : '') + '" data-ck="' + this._escapeHtml(k) + '">'
        + '<span class="tl-dot"></span>'
        + '<div class="tl-body"><div class="tl-date">' + this._escapeHtml(chronicleDateLabel(k)) + '</div>'
        + '<div class="tl-text">' + this._escapeHtml(now.get(k) || '（空）') + '</div></div></div>').join('');
      const spanTxt = keys.length ? ('　' + chronicleDateLabel(keys[0]) + ' — ' + chronicleDateLabel(keys[keys.length - 1])) : '';
      this._openPage(this._pageHeadHTML('🕰 历史时间轴', '本局 ' + keys.length + ' 条' + spanTxt, '')
        + '<div class="pg-body"><div class="pg-main ds-scroll">'
        + (keys.length ? ('<div class="tl">' + rows + '</div>')
          : '<div class="pg-empty">本局还没有任何编年史记录。<br>AI 在节点里写下的「剧情日志」会自动按泰拉历排在这里。</div>')
        + '</div></div>');
      if (hiKey) {
        const el = this.win.document.querySelector('#game-page .tl-item.hi');
        if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} }
      }
    },

    _persistGameState(win) {
      const w = win || this.win;
      // 剧情日志：每次落盘前先按年月日重排（AI 新条目只会被 MVU 追加到末尾）
      try { this._sortChronicle(); } catch (e) {}
      try { this._syncPromoteSentence(); } catch (e) {}   // 报价自愈：每次落盘顺手核对一次（幂等，不变不写）
      writeVars(w, (d) => {
        if (!d['_探索进程']) d['_探索进程'] = {};
        d['_探索进程'].$当前状态 = State.currentStatus || 'out_of_game';
        d['_探索进程'].$当前层数 = State.currentLayer || 1;
        const m = d['$地图状态'];
        if (m) m.层数 = State.currentLayer;
      });
    },

    _restoreGameState() {
      try { this._syncPromoteSentence(); } catch (e) {}   // 重开窗口时补齐/校正晋升报价（旧存档没有该键）
      try {
        const v = readVars(this.win);
        const prog = v['_探索进程'] || {};
        if (prog.$当前层数) State.currentLayer = Number(prog.$当前层数) || 1;
        const ni = v['$切片'] || {};
        if (ni.$active) {
          const nd = (ni.$nodeData && typeof ni.$nodeData === 'object') ? ni.$nodeData : null;
          State.currentNodeData = nd;
          State.nodeType = nd ? nd.type : '';
          State.gameOpened = true;
          return 'event_node';
        }
        const allowed = ['out_of_game', 'preparation', 'map_navigation', 'event_node'];
        const st = allowed.includes(prog.$当前状态) ? prog.$当前状态 : 'out_of_game';
        if (st === 'map_navigation' || st === 'event_node' || st === 'preparation') State.gameOpened = true;
        // 重开兜底：恢复进入对局时若 核心生命 ≤ 0（AI 已扣减致败），直接判定失败回主城
        if (State.gameOpened) {
          const res = v['玩家资源'] || {};
          if (res.核心生命 != null) {
            const hp = Number(res.核心生命);
            if (isFinite(hp) && hp <= 0) {
              try { this._resetRun(); } catch (e) {}
              return 'out_of_game';
            }
          }
        }
        State.nodeUI = null;
        return st;
      } catch (e) { return 'out_of_game'; }
    },

    _resetNodeTransient() {
      State.currentNodeData = null;
      State.nodeType = '';
      State.nodeUI = null;
      this._persistNodeSlice(null);
    },

    // ── 失败锁定态（**纯内存临时态，不写切片、不支持关窗复原**）────────────────────────
    //  作者口径：判定到失败后**不要瞬间退回首页** —— 冻结操作、只留一个按钮，
    //  让玩家还能翻看聊天记录 / 编队 / 标本室，自己决定什么时候回罗德岛。
    //  关窗重开不走这里：恢复路径发现 核心生命 ≤ 0 会直接复位回主城（见 _restoreGameState）。
    _enterFailedState() {
      if (State.failed) return;
      State.failed = true;
      try {
        this.body.classList.add('run-failed');
        // 选项栏 / 商店购买面板全部撤掉（它们都会改对局）
        const r = this.win.document.getElementById('option-rail');
        if (r) r.remove();
        this.body.classList.remove('has-option-rail');
        this._removeShopBuyBtn();
        // 输入框只读：防回车绕过按钮锁
        const il = this.win.document.getElementById('chat-input');
        if (il) il.readOnly = true;
      } catch (e) {}
      this._showFailBanner();
    },

    /** 失败横幅：唯一出口是「返回罗德岛」按钮 */
    _showFailBanner() {
      try {
        const doc = this.win.document;
        const old = doc.getElementById('fail-banner');
        if (old) old.remove();
        const box = doc.createElement('div');
        box.id = 'fail-banner';
        box.innerHTML = '<div class="fb-title">本局已失败</div>'
          + '<div class="fb-sub">核心生命已归零，本次探索到此为止。<br>'
          + '你仍可以翻看聊天记录、干员编队与标本室；准备好之后再回罗德岛。</div>'
          + '<button class="mini-btn gold" id="fail-return">返回罗德岛</button>';
        doc.body.appendChild(box);
        const btn = doc.getElementById('fail-return');
        if (btn) btn.onclick = () => this._returnHomeAfterFail();
      } catch (e) {}
    },

    /** 解除失败锁定（**必须先解除再切视图**，否则会出现"回了主页还锁着按钮"） */
    _clearFailedState() {
      State.failed = false;
      try {
        this.body.classList.remove('run-failed');
        const b = this.win.document.getElementById('fail-banner');
        if (b) b.remove();
        const il = this.win.document.getElementById('chat-input');
        if (il) { try { if (!this._nodeLocked()) il.readOnly = false; } catch (e) { il.readOnly = false; } }
      } catch (e) {}
    },

    /** 点「返回罗德岛」：先解锁、再走原有的复位+回主城 */
    _returnHomeAfterFail() {
      this._clearFailedState();
      this._resetRun();
    },

    /**
     * 前端失败判定：核心生命 ≤ 0 → 进入**失败锁定态**（不立刻回主城，等玩家点按钮）。
     * 扣减完全由 AI 判定并写入变量，前端只读检测、不参与扣减；
     * 判定时机 = 收到 AI 回复后（_handleAiReply）；关窗重开的兜底在 _restoreGameState（那里直接复位回主城）。
     */
    _checkRunFailed() {
      try {
        // 重玩模式：纯剧情体验，没有节点也没有战斗 → 永不判失败（哪怕 核心生命 被写成 0）
        if (this._replayOn()) return false;
        if (!State.gameOpened) return false;
        if (State.currentStatus !== 'map_navigation' && State.currentStatus !== 'event_node') return false;
        if (State.failed) return true;                   // 已在失败态：继续拦住后续处理
        const res = readVars(this.win)['玩家资源'] || {};
        if (res.核心生命 == null) return false;          // 未扣减（默认 10）→ 不算失败
        const hp = Number(res.核心生命);
        if (!isFinite(hp) || hp > 0) return false;
        this._enterFailedState();
        return true;
      } catch (e) { return false; }
    },

    /**
     * 本局结束（通关 / 失败 / 熔断）→ 复位为初始状态。
     * **经济复位是唯一权威入口**：玩家只有通关或失败后才会回到开局界面重选编队，
     * 因此每次重回开局界面时经济必然是初始值（10 / 0 / 0 / 0），
     * 之后「确认并出发」再把难度/分队修正叠加上去 —— 【重置】→【叠加】如此循环。
     */
    _resetRun() {
      try {
        State.failed = false;                     // 复位也解除失败锁定（switchView 里还有一道）
        writeVars(this.win, (d) => {
          // 本局变量整体复位（唯一权威口径，与通关路径共用同一份 draft 逻辑）
          this._resetRunScopedDraft(d);
        });
        State.currentLayer = 1;
        State.mapCache = null;
        State.currentNodeData = null;
        State.nodeType = '';
        State.pendingLeaveNote = '';
        State.entryRoster = null;   // 编队快照作废（防非通关离开节点的"回填保底"把上一局干员塞回新局）
        this._resetPrepSelection();
        this.switchView('out_of_game');
      } catch (e) { console.warn('[集成战略] _resetRun 失败', e && e.message); }
    },

    loadChatTargets() {
      const sel = this.win.document.getElementById('target-selector');
      if (!sel) return;
      const v = readVars(this.win);
      const roster = Object.keys(v['干员编队'] || {});
      const base = (v._探索进程 && v._探索进程.$基底干员) || '';
      sel.innerHTML = '';
      const add = (val, txt) => { const o = this.win.document.createElement('option'); o.value = val || ''; o.textContent = txt; sel.appendChild(o); };
      add('', '(无指定对象)');
      const order = base ? [base, ...roster.filter((n) => n !== base)] : roster;
      order.forEach((n) => add(n, cleanName(n)));
    },
    loadHistoryChat() {
      const hist = this.win.document.getElementById('chat-history');
      if (!hist) return;
      hist.innerHTML = ''; // 重刷（不删原始消息）
      if (!this.win.getChatMessages) return;
      try {
        const msgs = this.win.getChatMessages('0-{{lastMessageId}}', { role: 'all' });
        State.chatClean = this._cleanRawTextForDisplay(msgs);
        // 默认只渲染最后 chatVisible 楼；其余滚动到顶部点「更多」再加载
        State.chatVisible = Math.min(State.CHAT_PAGE, State.chatClean.length) || 0;
        this._renderChatWindow();
      } catch (e) {}
    },

    /** 渲染聊天窗口：顶部「更多历史」按钮 + 最后 State.chatVisible 条消息。 */
    _renderChatWindow() {
      const hist = this.win.document.getElementById('chat-history');
      if (!hist) return;
      hist.innerHTML = '';
      // 整层重刷时先撤掉 Galgame 接管标记；若本次有消息要打字，appendChat 会重新加上
      const ccR = this.win.document.getElementById('chat-container');
      if (ccR) ccR.classList.remove('gal-on');
      const clean = State.chatClean || [];
      const visible = Math.max(0, State.chatVisible);
      const sliceFrom = Math.max(0, clean.length - visible);
      // 顶部「更多」按钮：还有更早未显示时显示，点击再加载 CHAT_PAGE 条
      if (sliceFrom > 0) {
        const moreBtn = this.win.document.createElement('button');
        moreBtn.className = 'chat-more-btn';
        moreBtn.textContent = `↥ 加载更早的 ${Math.min(State.CHAT_PAGE, sliceFrom)} 条历史…`;
        moreBtn.onclick = () => this._loadMoreChat();
        hist.appendChild(moreBtn);
      }
      clean.slice(sliceFrom).forEach((m) => this.appendChat(m.role, m.name, m.text, m.id, m.isStructured));
      if (!clean.length) {
        const hint = this.win.document.createElement('div');
        hint.className = 'chat-empty';
        hint.textContent = '对话会出现在这里…';
        hist.appendChild(hint);
      }
      // 滚动到底部（最新）
      hist.scrollTop = hist.scrollHeight;
      // 玩家最后一条消息 → 悬浮在对话窗外的左上角气泡（Galgame 风）
      try { this.renderLastUserBubble(); } catch (e) {}
      // Galgame 窗口与历史对齐：
      //  · 若正好有一条新正文刚加载（appendChat 已启动）→ 不要覆盖它；
      //  · 否则把窗口恢复到「最后一条 AI 正文」的全部页（停在它当前页/第 1 页）。
      try {
        this._galSyncFromHistory();
        // 兜底：清洗缓存路径没出页的话，直连接口现取最新 AI 正文
        if (!(this._galGroups || []).length) this._galLoadLatest();
        const gl = this.win.document.getElementById('gal-layer');
        if (gl) gl.classList.toggle('on', this._galVisible() && !!(this._galGroups || []).length);
      } catch (e) {
        console.warn('[集成战略] Galgame 窗口同步异常：', e && e.message);
      }
      // 对话框内容刚换过（高度可能随之变化，且上面刚切了显隐）→ 让位与立绘层必须重量，
      // 否则立绘层会停在"上一屏"的高度上（曾表现为立绘莫名变小且不自愈）。
      this._galLayoutSettle();
    },

    /** 「更多」按钮：往上多加载 CHAT_PAGE 条历史（显示条数翻倍式往上补）。 */
    _loadMoreChat() {
      State.chatVisible = Math.min(State.chatVisible + State.CHAT_PAGE, State.chatClean.length);
      this._renderChatWindow();
    },

    /** 修剪聊天正文中的隐藏标签块：metacognition/love_qkll 思考块、recap/safe 摘要块、summary 摘要块、update/updatevariable 变量块。 */
    _stripHiddenTags(text) {
      if (!text) return '';
      let t = text;
      // 思绪/约定块：[metacognition]…[/thinking] 或 [love_qkll]…，含换行与 <...> 变体。
      // 用户提供的原正则：/\[(?:metacognition|love_qkll)\]\s*((?:(?!\n(?:<\/thinking>|<content>)).)+)\s*\n(?:<\/thinking>|(?=<content>))/si
      t = t.replace(/\[(?:metacognition|love_qkll)\]\s*((?:(?!\n(?:<\/thinking>|<content>)).)+)\s*\n(?:<\/thinking>|(?=<content>))/si, '');
      // <recap>…</recap> 或 <safe>…</safe>（含到行尾无闭合的情况）
      t = t.replace(new RegExp('<(recap|safe)>(?:(?!.*</\\1>)(?:(?!<\\1>).)*$|(?:(?!<\\1>).)*</\\1?>)', 'gsi'), '');
      // <summary>…</summary>（有损压缩摘要：预设里的远楼层摘要块，属隐藏内容；含未闭合的情况）
      t = t.replace(/<summary>[\s\S]*?<\/summary>/gi, '');
      t = t.replace(/<summary>[\s\S]*$/gi, '');
      t = t.replace(/<\/?summary>/gi, '');
      // <update>…</update> / <updatevariable>…</updatevariable>
      t = t.replace(new RegExp('<(update(?:variable)?)>(?:(?!.*</\\1>)(?:(?!<\\1>).)*$|(?:(?!<\\1>).)*</\\1?>)', 'gsi'), '');
      return t;
    },

    // ═══════════════════════════════════════════════════════════════════════════════════
    // 【正文 / 选项识别 · 唯一口径】
    //   剥标签的方向由**位置**决定（作者口径）：
    //     · 思维链 <thinking> 只可能出现在最前面 → **向前剥**：正文从最后一个 </thinking> 之后开始
    //       （AI 不可能把思维链写到回复末尾，所以"最后一个"是安全的上界）；
    //     · 选项 / 摘要 <summary> / 变量 <UpdateVariable>·<JSONPatch> 只可能跟在正文后面 →
    //       **向后剥**：正文到它们**第一次**出现的位置为止。
    //   选项三通道（都从正文里剥掉、都不显示，各自独立解析成【选项】栏）：
    //     ① <action_options>…</action_options> —— 旧消息 / 旧世界书，向后兼容，永久保留
    //     ② 正文末尾单独一行的「【选项】」标记 —— 主通道，最可靠（没有标签可忘闭合）
    //     ③ 裸编号兜底 —— 「位置靠后的连续编号块」（1: / 2: …，允许「简介：」续行）
    //        ⚠ 不限制最少条数：只有 1 条选项是合法局面（商店、单分叉）。
    //   ⚠ 顺序要求：先剥变量/摘要块，再切选项 —— <JSONPatch> 里全是数字、数组、引号，
    //     若它落进正文候选，编号识别会被污染。
    // ═══════════════════════════════════════════════════════════════════════════════════

    /** 大小写不敏感地列出 word 在 t 里的所有出现位置（下标按**原串**计，不受小写变形影响）。 */
    _findAllCI(t, word) {
      const out = [];
      const s = String(t == null ? '' : t);
      const w = String(word || '');
      if (!w) return out;
      const low = s.toLowerCase();
      const wl = w.toLowerCase();
      if (low.length !== s.length) {          // 极少数会变长的小写变形 → 退化为精确匹配
        let i = -1;
        while ((i = s.indexOf(w, i + 1)) !== -1) out.push(i);
        return out;
      }
      let i = -1;
      while ((i = low.indexOf(wl, i + 1)) !== -1) out.push(i);
      return out;
    },

    /**
     * 挖掉**整块思维链**（块内一切内容一并丢弃）。
     *  ⚠ 这一步必须最先做：AI 在思维链里常把 <content> / <action_options> / <summary> 当"写作计划"
     *    写出来（"我打算在 <content> 里写……""选项就按 <action_options> 那样给"）。若不先挖干净，
     *    那些**假标签**会被后续每一条识别当真 —— 思维链里的 <action_options> 被当成真选项、
     *    思维链里的 <content> 被当成真正文，于是正文彻底错乱。
     *  支持四种形态（都是"向前剥"）：
     *    ① 成对 <thinking>…</thinking>（含 [/thinking] 变体）→ 整块挖掉，有几块挖几块；
     *    ② 未闭合 <thinking>（没有闭合标签）→ 只保留它之后**第一条以 {指向角色} 收尾的行**起的部分
     *       （正文的天然特征；找不到锚点行则宁可整段丢弃，绝不把思维链当正文）；
     *    ③ 旧变体 [metacognition] / [love_qkll] 思考块（别的模型的写法）→ 同样整块挖掉；
     *    ④ 残留的孤立 <thinking> / </thinking> / [/thinking] 等字面量一并清除。
     *  @returns {{ text:string, had:boolean }}
     */
    _stripThinkingBlocks(src) {
      let t = String(src == null ? '' : src);
      let had = false;
      const openRe = /<thinking\b[^>]*>/gi;
      if (openRe.test(t)) had = true;
      // ① 成对块：一律惰性匹配、全部挖掉（不跨越未闭合的开标签）
      const pairedRe = /<thinking\b[^>]*>[\s\S]*?(?:<\/thinking\s*>|\[\/thinking\])/gi;
      if (pairedRe.test(t)) t = t.replace(pairedRe, '\n');
      // ② 还没闭合的开标签 → 从**最后一个**开标签起按"向前剥"处理
      const openRe2 = /<thinking\b[^>]*>/gi;
      let om = null;
      let lastOpen = null;
      while ((om = openRe2.exec(t)) !== null) lastOpen = om;
      if (lastOpen) {
        const idx = lastOpen.index;
        const after = idx + lastOpen[0].length;
        const rest = t.slice(after);
        const lines = rest.split('\n');
        let off = after;
        let keep = -1;
        for (let i = 0; i < lines.length; i++) {
          if (/\{[^{}\n]*\}\s*$/.test(lines[i].trim())) { keep = off; break; }
          off += lines[i].length + 1;
        }
        t = t.slice(0, idx) + (keep >= 0 ? t.slice(keep) : '');
      }
      // ③ 旧变体 [metacognition]/[love_qkll] 思考块（别的模型写法）：与 <thinking> 同理，
      //    块里写到的假标签一样会污染识别，所以先在这里挖掉。
      //    ⚠ 必须排在"清掉孤立 </thinking> 字面量"**之前** —— 这一支要靠 `</thinking>` 当收尾标记。
      //    分两趟、闭合标签优先：先挖"有 </thinking> 收尾"的，剩下的（没有收尾）才挖到下一个协议标签之前。
      const metaClosed = /\[(?:metacognition|love_qkll)\][\s\S]*?(?:<\/thinking\s*>|\[\/thinking\])/gi;
      if (metaClosed.test(t)) { had = true; t = t.replace(metaClosed, '\n'); }
      const metaOpen = /\[(?:metacognition|love_qkll)\][\s\S]*?(?=<content\b|<summary\b|<updatevariable\b)/gi;
      if (metaOpen.test(t)) { had = true; t = t.replace(metaOpen, '\n'); }
      // ④ 最后清掉孤立标签字面量
      t = t.replace(/<\/?thinking\b[^>]*>/gi, '').replace(/\[\/?thinking\]/gi, '');
      t = t.replace(/\[\/?metacognition\]|\[\/?love_qkll\]/gi, '');
      return { text: t, had };
    },

    /** 取"正文候选区"：有成对 <content> 就用它（多个取**最长**那块），否则按边界推断。
     *  ⚠ 入参必须是**已挖掉思维链**的文本（见 _stripThinkingBlocks）——否则思维链里的 <content> 会抢先命中。 */
    _bodyCandidate(src) {
      const t = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
      // ① 成对 <content …>…</content>：AI 重发时会有多块 —— 取最长的那块（而不是 join，避免正文重复）
      const re = /<content\b[^>]*>([\s\S]*?)<\/content\s*>/gi;
      let m;
      let best = null;
      while ((m = re.exec(t)) !== null) { if (best === null || m[1].length > best.length) best = m[1]; }
      if (best !== null) return best;
      // ② 没有成对 content → 起点：最后一个**行首**的 <content> 开标签之后。
      //    ⚠ 必须要求"在行首"：正文里提到标签（「标签写成 <content> 这样」）不会截断正文。
      let start = 0;
      const lineOpens = [...t.matchAll(/^[ \t]*<content\b[^>]*>/gim)];
      if (lineOpens.length) {
        const lastOpen = lineOpens[lineOpens.length - 1];
        start = lastOpen.index + lastOpen[0].length;
      }
      // ③ 终点（向后剥摘要/变量块；顺手处理"只有闭标签"的 content）
      let end = t.length;
      ['<summary', '<updatevariable', '<jsonpatch', '</content>'].forEach((needle) => {
        const idxs = this._findAllCI(t, needle);
        for (let k = 0; k < idxs.length; k++) {
          const i = idxs[k];
          if (i >= start && i < end) { end = i; break; }   // idxs 升序 → 第一个命中的就是最早的
        }
      });
      if (end < start) end = t.length;
      return t.slice(start, end);
    },

    /** 通道①：剥 <action_options>（成对 → 挖掉；未闭合 → 吃到末尾）。返回 { text, block }。 */
    _cutLegacyOptions(text) {
      const t = String(text == null ? '' : text);
      const paired = /<action_options>([\s\S]*?)<\/action_options>/i.exec(t);
      if (paired) return { text: t.slice(0, paired.index) + t.slice(paired.index + paired[0].length), block: paired[1] };
      const unclosed = /<action_options>([\s\S]*)$/i.exec(t);
      if (unclosed) return { text: t.slice(0, unclosed.index), block: unclosed[1] };
      return { text: t, block: null };
    },

    /** 通道②：正文末尾单独一行的「【选项】」标记 → 标记之后全是选项。返回 { text, block }。 */
    _cutMarkerOptions(text) {
      const t = String(text == null ? '' : text);
      const lines = t.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // 整行就是标记（允许 【选项】/[选项]/## 选项/选项： ），标记行后面的残余文字算第一条选项
        const mm = /^(?:[【\[]\s*选\s*项\s*[】\]]|#{1,4}\s*选\s*项|选\s*项\s*[:：])\s*([\s\S]*)$/.exec(lines[i].trim());
        if (!mm) continue;
        const tail = String(mm[1] || '').trim();
        if (tail) {
          // 标记行上还写了内容（如「【选项】1: xxx」）→ 它属于选项块
          return { text: lines.slice(0, i).join('\n'), block: [tail, ...lines.slice(i + 1)].join('\n') };
        }
        // 「【选项】」独占一行时，必须满足"位置靠后"：标记之后不能再出现正文段落
        return { text: lines.slice(0, i).join('\n'), block: lines.slice(i + 1).join('\n') };
      }
      return { text: t, block: null };
    },

    /** 通道③：裸编号兜底 —— **位置靠后**的连续编号块。返回 { text, block }。 */
    _cutNumberedTail(text) {
      const t = String(text == null ? '' : text);
      const lines = t.split('\n');
      const mNum = (s) => /^\s*(\d{1,2})\s*[:：、)）]\s*\S/.exec(s);
      const isDesc = (s) => /^\s*(?:简介|说明)\s*[:：]/.test(s);
      const isBlank = (s) => !String(s).trim();
      const isAnchorOnly = (s) => /^\s*(?:\{[^{}\n]*\}\s*)+$/.test(String(s).trim());
      const nums = [];
      lines.forEach((s, i) => { if (mNum(s)) nums.push(i); });
      if (!nums.length) return { text: t, block: null };
      const lastNum = nums[nums.length - 1];
      // ① 位置靠后：从最后一个编号行到**文末**必须全是 编号 / 简介 / 空行 / 纯锚点行
      for (let i = lastNum + 1; i < lines.length; i++) {
        if (!(mNum(lines[i]) || isDesc(lines[i]) || isBlank(lines[i]) || isAnchorOnly(lines[i]))) {
          return { text: t, block: null };
        }
      }
      // ② 向前回溯起点：穿过 编号 / 简介 / 空行 / 纯锚点行，停在正文行上
      let start = lastNum;
      while (start - 1 >= 0 && (mNum(lines[start - 1]) || isDesc(lines[start - 1]) || isBlank(lines[start - 1]) || isAnchorOnly(lines[start - 1]))) start--;
      // ③ 跳过前导空行，块必须以编号行开头
      while (start < lines.length && isBlank(lines[start])) start++;
      if (start >= lines.length || !mNum(lines[start])) return { text: t, block: null };
      // ④ 首项编号必须是 1（正文里的清单一般不会从 1 起整段编号；找不到就宁可不切）
      if (Number(mNum(lines[start])[1]) !== 1) return { text: t, block: null };
      // ⑤ 与正文的分界证据：块前面要么是空行，要么上一行以 {指向角色} 收尾（正文行的天然特征）
      const prev = start - 1;
      if (prev >= 0 && !isBlank(lines[prev]) && !/\}\s*$/.test(lines[prev].trim())) return { text: t, block: null };
      return { text: lines.slice(0, start).join('\n'), block: lines.slice(start).join('\n') };
    },

    /** 选项行解析：`1:【标题】` + 可选「简介：…」续行。loose=标记通道时，无编号的行也算一条选项。 */
    _parseOptionLines(block, loose) {
      if (block == null) return [];
      const out = [];
      let cur = null;
      const push = (n, title) => { if (!title) return; cur = { n, title, desc: '' }; out.push(cur); };
      String(block).split('\n').forEach((rawLine) => {
        const line = String(rawLine).trim();
        if (!line) return;
        if (/^System\s*:/i.test(line)) return;
        const mNum = /^(?:[-*·•]\s*)?(\d{1,2})\s*[:：、.)）]\s*(.+)$/.exec(line);
        if (mNum) { push(Number(mNum[1]), this._cleanOptText(mNum[2], true)); return; }
        const mDesc = /^(?:简介|说明)\s*[:：]\s*(.+)$/.exec(line);
        if (mDesc) { if (!cur) push(out.length + 1, this._cleanOptText('（选项）', true)); cur.desc = this._cleanOptText(mDesc[1], false); return; }
        if (!loose) return;   // 非宽松通道：既不是编号也不是简介 → 忽略（旧行为）
        const mBullet = /^(?:[-*·•]\s*)(.+)$/.exec(line);
        push(out.length + 1, this._cleanOptText((mBullet ? mBullet[1] : line), true));
      });
      return out.filter((it) => it && it.title);
    },

    /** 选项标题/简介清洗：剥一层【】「」『』[] 包裹与首尾空白（标题不再把括号当前缀显示）。 */
    _cleanOptText(s, isTitle) {
      let t = String(s == null ? '' : s).trim();
      const wrap = /^[【\[「『]\s*([\s\S]*?)\s*[】\]」』]$/;
      const m = wrap.exec(t);
      if (m && m[1]) t = m[1].trim();
      t = t.replace(/^[【\[「『]+/, '').replace(/[】\]」』]+$/, '').trim();
      return isTitle ? t.replace(/\s*\n\s*/g, ' ') : t;
    },

    /** 清残留的"协议标签字面量"（正文里永不出现标签）：<content>、</summary>、<options> 等等。 */
    _stripProtocolTags(text) {
      let t = String(text == null ? '' : text);
      // 选项类旧标签（含 <options>/<option>/<option1> 变体）：成对挖掉；未闭合则吃到末尾
      t = t.replace(/<options?\b[^>]*>[\s\S]*?<\/options?\b[^>]*>/gi, '');
      t = t.replace(/<options?\b[^>]*>[\s\S]*$/i, '');
      // 所有协议标签的字面量（含 <Interleaving>：有些模型会在正文最前面垫一个它，只剥标签、留内容）
      t = t.replace(/<\s*\/?\s*(?:content|summary|thinking|analysis|jsonpatch|updatevariable|action_options|options?|eventp|interleaving)\b[^>]*>/gi, '');
      return t.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    },

    /**
     * █ 核心入口：把一条 AI 原始消息拆成 { body, items, channel }。
     *   body   —— 可直接拿去切页 / 匹配立绘的正文（**保留 <角色名> 与 {指向角色} 锚点**，
     *             脱壳与去锚点在显示层 _md/_galStripNameTags 做）
     *   items  —— [{ n, title, desc }]，供右侧选项栏渲染
     *   channel——'action_options' | 'marker' | 'numbered' | ''（命中通道，排查用）
     */
    _extractBodyAndOptions(raw) {
      const src = String(raw == null ? '' : raw);
      if (!src.trim()) return { body: '', items: [], channel: '' };
      // ① 【永远最先】挖掉整块思维链。
      //    思维链里 AI 会把 <content>/<action_options>/<summary> 当"写作计划"写出来，
      //    不先挖干净，后面每一条识别都会被假标签带偏（正文错乱、选项错乱都源于此）。
      const noThink = this._stripThinkingBlocks(src).text;
      // ② 旧标签通道（在"无思维链"的文本上挖）
      const cutA = this._cutLegacyOptions(noThink);
      let items = this._parseOptionLines(cutA.block, false);
      let channel = items.length ? 'action_options' : '';
      // ③ 取正文候选区（成对 content 优先 / 否则边界推断）
      let text = this._bodyCandidate(cutA.text);
      // ④ 【选项】标记通道
      if (!items.length) {
        const cutB = this._cutMarkerOptions(text);
        if (cutB.block != null) {
          const its = this._parseOptionLines(cutB.block, true);
          if (its.length) { items = its; channel = 'marker'; text = cutB.text; }
        }
      }
      // ⑤ 裸编号兜底
      if (!items.length) {
        const cutC = this._cutNumberedTail(text);
        if (cutC.block != null) {
          const its = this._parseOptionLines(cutC.block, false);
          if (its.length) { items = its; channel = 'numbered'; text = cutC.text; }
        }
      }
      // ⑥ 清残留标签 + 兜一层隐藏块（<recap>/未闭合 <update> 等旧变体）
      let body = this._stripProtocolTags(text);
      try { body = this._stripHiddenTags(body); } catch (e) {}
      return { body: String(body || '').trim(), items, channel };
    },

    /** 只要正文（显示层到处都用它）：等价于 _extractBodyAndOptions(raw).body */
    _extractContent(text) {
      return this._extractBodyAndOptions(text).body;
    },

    /** 白名单：剥离所有 <eventp>…</eventp> 结构化战报块（仅用户输入使用）。
     *  只隐藏战报，保留真实输入内容。
     *  ⚠ 贪婪兜底：先按成对闭合块惰性剪除（不跨块吞真实输入），再把**未闭合**的 <eventp> 吞到文末。
     *    非贪婪在闭合标签被误吞/残缺时（如 _stripHiddenTags 把文案里字面量 updatevariable 当未闭合块
     *    吃掉 </eventp> 闭合）会整段漏剪，导致 <eventp> 及其内容直接显示——已踩坑。 */
    _stripEventp(text) {
      if (!text) return '';
      let t = String(text || '');
      t = t.replace(/<eventp>[\s\S]*?<\/eventp>/gi, '');   // 成对闭合块（惰性，避免跨块误吞正文）
      t = t.replace(/<eventp>[\s\S]*$/gi, '');              // 未闭合 <eventp> 贪婪吞到文末（漏剪兜底）
      t = t.replace(/<\/eventp>/gi, '');                    // 孤立闭合标签清理
      // advice 固定占位句一并隐藏（占位句是前端交互产物，不是玩家真实输入）
      return t.replace(ADVICE_PLACEHOLDER_RE, '').trim();
    },

    /** 清洗消息：去掉控制性标签，保留正文；并识别结构化文本（白名单制）。 */
    _cleanRawTextForDisplay(msgs) {
      const out = [];
      (msgs || []).forEach((m) => {
        if (m.role === 'system' || m.is_hidden) return;
        let text;
        let isStructured = false;
        if (m.role === 'assistant') {
          // 正文唯一口径：_extractBodyAndOptions（剥思考/摘要/变量 → 切选项 → 清残留标签）。
          // ⚠ 这里**不**脱 <角色名> 壳、**不**去 {指向角色} 锚点：下游 _galSplitGroups 要靠它们
          //   匹配头像/立绘；显示时的脱壳与去锚点在 _md / _galStripNameTags 里做（曾因这里提前脱壳
          //   导致兜底路径立绘全暗）。
          text = this._extractBodyAndOptions(m.message || '').body;
          if (/<Option>/i.test(m.message || '')) isStructured = true;
        } else {
          // 白名单：用户输入隐藏所有 <eventp> 结构化战报，保留真实输入显示
          text = this._stripEventp(this._stripHiddenTags(m.message || ''));
        }
        // 若剥离后为空，说明这条只含被隐藏的标签内容（如纯战报/纯标签）——
        // 用 ◇ 占位提示，避免出现"彻底空消息"。
        if (!text || !text.trim()) text = '◇';
        // 用户消息名：ST 默认占位名 <user> / 宏占位 {{User}} → 显示真实用户名（捕获不到则 '你'）
        const uname = (m.name === '<user>' || m.name === '{{User}}') ? (_userName || '你') : (m.name || '…');
        out.push({ role: m.role === 'assistant' ? 'ai' : 'user', name: uname, text: text.trim(), id: m.message_id, isStructured });
      });
      return out;
    },

    appendChat(role, name, text, id, isStructured) {
      const hist = this.win.document.getElementById('chat-history');
      if (!hist) return;
      const doc = this.win.document;
      const msg = doc.createElement('div');
      msg.className = 'chat-msg ' + role;
      msg.dataset.id = id;
      const nameEl = doc.createElement('div');
      nameEl.className = 'chat-name';
      nameEl.innerText = this._galStripNameTags(String(name || ''));
      const bubble = doc.createElement('div');
      bubble.className = 'chat-bubble';
      msg.appendChild(nameEl);
      msg.appendChild(bubble);
      // 消息级功能按钮（🔄重Roll / 🗑️删除 / ✏️编辑）：
      // Galgame 未展开时**不放进来**（避免误点），只在展开的"对话记录"里用（见 _renderChatWindow）。
      const cc0 = doc.getElementById('chat-container');
      const expandedNow = !!(cc0 && cc0.classList.contains('expanded'));
      if (id && expandedNow) {
        const ctrl = doc.createElement('div');
        ctrl.className = 'msg-controls';
        const mk = (label, fn, danger) => {
          const b = doc.createElement('button');
          b.className = 'ctrl-btn' + (danger ? ' danger' : '');
          b.innerText = label;
          b.onclick = () => fn();
          ctrl.appendChild(b);
        };
        if (role === 'user') { mk('✏️', () => this._editMsg(id), false); mk('🗑️', () => this._delMsg(id), true); }
        // 重roll 已移到输入框旁（#chat-reroll），记录里不再放 🔄
        else { mk('🗑️', () => this._delMsg(id), true); }
        msg.appendChild(ctrl);
      }
      // ---- 正文 ----
      //  ⚠ Galgame 窗口是**独立渲染层**：正文不再画进这个气泡里，而是交给 `_galPlay()` 在
      //  #gal-layer 上切页显示（纯翻页，无打字）；气泡只在「展开的对话记录」里保留一份静态文本。
      if (role !== 'user') {
        try {
          // 只有"这条有实际可见正文"才占窗口播放；纯思考/纯隐藏标签（◇）不占位，
          // 让 _galSyncFromHistory 回退到上一条有正文的 AI 回复。
          const hasVisibleText = !!String(text || '').trim() && String(text).trim() !== '◇';
          const canPlay = !!id && !expandedNow && !this._galSeen[id] && hasVisibleText && this._galCanPlay();
          if (canPlay && this._galPlay(text, id)) {
            this._galSeen[id] = 1;
            bubble.innerHTML = this._md(text);   // 隐藏的那份记录仍然完整
          } else {
            bubble.innerHTML = this._md(text);
          }
        } catch (e) {
          console.warn('[集成战略] Galgame 渲染失败，退回普通渲染：', e && e.message);
          try { bubble.innerHTML = this._md(text); } catch (e2) {}
        }
      } else {
        bubble.innerHTML = this._md(text);
      }
      if (isStructured) bubble.style.borderColor = '#b042ff';
      hist.appendChild(msg);
      hist.scrollTop = hist.scrollHeight;
    },

    /** 只有「最后一条消息」用 Galgame 窗口承载：避免每次重刷都把旧消息重载一遍。
     *  ⚠ role 判断必须同时认 'ai'：_cleanRawTextForDisplay 把原始 'assistant' 清洗成了 'ai'，
     *  只认 'assistant' 会永远判定失败 → 窗口空白（踩过的坑）。 */
    _galCanPlay() {
      try {
        const clean = State.chatClean || [];
        if (!clean.length) return false;
        const last = clean[clean.length - 1];
        return !!(last && (last.role === 'ai' || last.role === 'assistant'));
      } catch (e) { return false; }
    },

    /** 玩家最后一条发言 → 悬浮在对话窗**外面**的左上角气泡（Galgame 风）。找不到就隐藏。 */
    /** 玩家最后一条发言 → 悬浮在对话框「右上角、框外」的气泡。找不到就隐藏。
     *  @param forceText 可选：玩家刚发送/点击选项时直接传入显示文本（立即更新，
     *  不必等 loadHistoryChat 重算 chatClean）；省略则从聊天记录取最后一条 user。 */
    renderLastUserBubble(forceText) {
      const el = this.win.document.getElementById('gal-you');
      if (!el) return;
      let txt = '';
      if (forceText != null) {
        // 直接文本路径：复用记录修剪逻辑（剥 eventp 战报/隐藏标签），保留玩家输入与选项内容
        txt = this._galStripNameTags(this._stripEventp(this._stripHiddenTags(String(forceText))));
      } else {
        const clean = State.chatClean || [];
        let lastUser = null;
        for (let i = clean.length - 1; i >= 0; i--) { if (clean[i].role === 'user') { lastUser = clean[i]; break; } }
        txt = lastUser ? this._galStripNameTags(String(lastUser.text || '')) : '';
      }
      txt = txt.replace(/\s+/g, ' ').replace(/^(你|玩家)\s*[·:：]?\s*/, '').trim();
      // 纯选项/纯战报（◇ 占位）这类不算"我说的话"，不挂出来
      const skip = !txt || txt === '◇';
      if (skip) { el.classList.add('off'); el.textContent = ''; return; }
      el.textContent = txt.length > 140 ? txt.slice(0, 140) + '…' : txt;
      el.classList.remove('off');
    },

    /**
     * 【Galgame 正文切分·新协议版】
     *   以换行符为分隔：每行 = 一个「段」；每段末尾的 {指向角色} 是该段的锚点（_galAnchorOf 最长匹配）。
     *   每段都要**重新读取**锚点（不再沿用上一段说话人）；无锚点 → 头像无 + 立绘全暗。
     *   连续且锚点相同的行合并成一页（少翻页、头像不变）；标题/引用行照常自成一行。
     *  返回 [{ raw, text, anchor: 匹配后的角色key(含后缀)|'', chs: [<名字>...] }]。
     */
    _galSplitGroups(text) {
      const src = String(text || '').replace(/\r\n?/g, '\n');
      const out = [];
      const quoted = /^(?:&gt;|>)\s?/;
      let cur = null;   // 当前合并中的组
      const flush = () => {
        if (cur && cur.raw.length) {
          const raw = cur.raw.join('\n');
          out.push({
            raw,
            text: this._galStripNameTags(raw).trim(),
            anchor: cur.anchor,
            chs: cur.chs,
          });
        }
        cur = null;
      };
      const pushLine = (line) => {
        const anchor = this._galAnchorOf(line);   // {key,base} | ''
        const chs = (() => {
          const arr = [];
          const re = /<([^<>\n]{1,24})>/g;
          let m;
          while ((m = re.exec(line)) !== null) {
            const nm = this._galSpeakerOf(m[0]);
            if (nm && !arr.includes(nm)) arr.push(nm);
          }
          return arr;
        })();
        const special = /^#{1,4}\s/.test(line) || quoted.test(line);
        // 连续且锚点相同的普通行合并成一页；标题/引用行、锚点变化、空行都断开（比较锚点 key，非对象引用）
        const curKey = (cur && cur.anchor && cur.anchor.key) || '';
        const key = (anchor && anchor.key) || '';
        if (cur && !special && curKey === key) {
          cur.raw.push(line);
          cur.chs = cur.chs.concat(chs).filter((v, i, a) => a.indexOf(v) === i);
          return;
        }
        flush();
        cur = { raw: [line], anchor, chs };
      };
      src.split('\n').forEach((rawLine) => {
        const line = String(rawLine).trim();
        if (!line) { flush(); return; }
        pushLine(line);
      });
      flush();
      // 去掉彻底空白的组（说话人标签换成哨兵再判；{...} 锚点不算内容）
      return out.filter((g) => {
        const t = String(g.raw || '').replace(/<([^<>\n]{1,24})>/g, (full, inner) => {
          const rawIn = String(inner).trim();
          return /^(br|hr|p|b|i|em|strong|span|div)\b/i.test(rawIn) ? ' ' : '\u0001';
        }).replace(/\{[^{}]*\}/g, '');
        return !!t.replace(/[\s\u3000]+/g, '');
      });
    },

    /**
     * 取一段末尾的 {指向角色} 锚点：最后一行尾部的 {...} → { key: 原样(含编号), base: 图源基底名 }。
     * ① **标本身份键**（`阿米娅1234` / 玩家改名后的 `小阿米娅1234`）：以编队/标本库里那条记录为准，
     *    这样自定义名字也能出头像、出立绘（图源回退她卡上的 `原名`）。
     * ② 其余只认角色库真名（_matchKnownName）：{少女}/{她} 这类泛称 → ''（不匹配 → 头像无 + 立绘全暗）。
     */
    _galAnchorOf(raw) {
      const lines = String(raw || '').split('\n');
      let content = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /\{([^{}]*)\}\s*$/.exec(lines[i]);
        if (m) { content = String(m[1]).trim(); break; }
      }
      if (!content) return '';
      if (isSpecimenKey(content)) {
        try {
          const rec = _findPortraitRecord(readVars(this.win), content);
          if (rec) return { key: content, base: _portraitBaseFor(content, rec.记录) };
        } catch (e) {}
      }
      const base = _matchKnownName(content);   // 只认真名（最长前缀），不走 cleanName 兜底
      if (!base) return '';
      return { key: content, base };
    },

    /**
     * 剥掉「说话人包裹符」：**只去掉尖括号本身，名字必须原样保留**。
     *   旧实现把 <角色名> 整块删掉（名字一起消失），所以正文里只剩台词、说话人全没了；
     *   现在改为「<夏莲>「啊啊啊！」」→「夏莲「啊啊啊！」」，名字回到正文里。
     *   兼容写歪的变体：＜全角尖括号＞、【名字】（仅在整行就是名字时）、<user>/<玩家> → 你。
     *   另外顺手清掉选项块——正常已被 _extractContent 剥过，这里再兜一层，防止它被当正文显示。
     */
    _galStripNameTags(text) {
      let t = String(text || '')
        .replace(/<action_options>[\s\S]*?<\/action_options>/gi, '')
        .replace(/<\/?options?\b[^>]*>/gi, '');
      // 一些模型会在正文最前面垫一个 <Interleaving> / </Interleaving> 包裹标签：
      // **只剥标签本体**（内容原样保留），否则它会被当成"说话人标记"把 Interleaving 这个词漏进正文。
      t = t.replace(/<\s*\/?\s*interleaving\b[^>]*>/gi, '');
      // 新协议：{指向角色} 锚点**连同内容一起删除**（与尖括号不同——尖括号留名字，大括号整个删）
      t = t.replace(/\{[^{}]*\}/g, '');
      // 半角尖括号：只脱壳，保留内部文本（含 </名字> 这类误写的闭合）
      t = t.replace(/<([^<>\n]{1,24})>/g, (full, inner) => {
        let raw = String(inner).trim();
        // 误写成 </名字> 的闭合标签：去掉前导斜杠，名字照留
        if (raw.charAt(0) === '/') raw = raw.slice(1).trim();
        // 尖括号里放的是「格式化/协议」关键字时不属于说话人标记 → 原样留着，别误吞
        if (/^(br|hr|p|b|i|em|strong|content|eventp|action_options|options?|thinking|sum|details|span|div|interleaving)\b/i.test(raw)) return full;
        const nm = cleanName(raw);
        // 玩家自称统一显示为「你」
        if (nm === 'user' || nm === '玩家' || nm === '我') return '你';
        return raw;
      });
      // 全角尖括号 ＜名字＞
      t = t.replace(/＜([^＜＞\n]{1,24})＞/g, (full, inner) => String(inner).trim());
      return t;
    },

    /** 取一组的「说话人」名字（供 Galgame 名牌用）。 */
    _galSpeakerOf(text) {
      const m = /<([^<>\n]{1,24})>/.exec(String(text || ''));
      if (!m) return '';
      const raw = String(m[1]).trim();
      // <Interleaving> 之类的模型包裹标签不是说话人（否则名牌会显示成 "Interleaving"）
      if (/^(br|hr|p|b|i|em|strong|content|eventp|action_options|options?|thinking|sum|details|span|div|interleaving)\b/i.test(raw)) return '';
      const nm = cleanName(raw);
      if (nm === 'user' || nm === '玩家' || nm === '我') return '你';
      return raw;
    },

    /** 生成一页的 HTML（多行用 <p> 分行，保持极简 markdown）。
     *  ⚠ 传入的 text 必须**已经是脱壳后**的正文（见 _galSplitGroups），这里不再调 _galStripNameTags。 */
    _galGroupHTML(text) {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return String(text || '').split('\n').map((raw) => {
        let line = String(raw).trim();
        if (!line) return '';
        line = esc(line)
          .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
          .replace(/\*(.+?)\*/g, '<i>$1</i>');
        if (/^#{1,4}\s+/.test(line)) return '<p class="gal-head">' + line.replace(/^#{1,4}\s+/, '') + '</p>';
        if (/^&gt;\s?/.test(line)) return '<p class="gal-quote">' + line.replace(/^&gt;\s?/, '') + '</p>';
        return '<p>' + line + '</p>';
      }).filter(Boolean).join('');
    },

    // ═══════════════════════════════════════════════════════════════════════════════
    // 〘独立 Galgame 窗口引擎〙（无打字，纯翻页）
    //   · 每条 AI 正文按「自然段」切分（_galSplitGroups），**一次性把全部页都读好**；
    //   · 从第 1 页开始；单击聊天窗口任意处＝翻下一页；
    //   · 窗口左下角箭头＝回上一页；右下角箭头＝下一页；
    //   · 每页仍然按本页的 <角色名> 匹配头像与名牌（没带名字沿用上一页的人）。
    // ═══════════════════════════════════════════════════════════════════════════════

    /** 取 Galgame 窗口内的各元素（统一入口，避免到处重复 getElementById）。 */
    _galEls() {
      const d = this.win.document;
      return {
        layer: d.getElementById('gal-layer'),
        box: d.getElementById('gal-box'),
        body: d.getElementById('gal-body'),
        name: d.getElementById('gal-name'),
        ava: d.getElementById('gal-avatar'),
        next: d.getElementById('gal-next'),
        back: d.getElementById('gal-back'),
        pager: d.getElementById('gal-pager'),
        you: d.getElementById('gal-you'),
      };
    },

    /** 窗口是否应该可见：展开态是"对话记录"，此时收起 Galgame 窗口。 */
    _galVisible() {
      const d = this.win.document;
      if (!d.getElementById('gal-layer')) return false;
      const cc = d.getElementById('chat-container');
      if (cc && cc.classList.contains('expanded')) return false;
      return true;
    },

    /** 显示/隐藏整个 Galgame 窗口。 */
    _galShow(on) {
      const el = this._galEls();
      if (!el.layer) return;
      // ⚠ 先切 class 再算让位：_galLayout / _expandBtnLayout 都要读对话框(gal-box)的真实位置，
      //   而 display:none 时它的 rect 全是 0（顺序反了会拿到上一态的坐标）。
      el.layer.classList.toggle('on', !!on);
      this._galLayoutSettle();
      // 立绘同台层显隐跟随 gal 窗口（展开对话记录时一并隐藏）
      try { PortraitStage.setVisible(!!on); } catch (e) {}
    },

    /**
     * 让位重排的**稳定化**版本：立刻量一次给手感，再在 80ms / 300ms 补量两次。
     *  · 为什么要补：切 class 之后、图片/字体加载完之前，gal-box 的高度可能还没定型；
     *    那一刻量到的让位会把立绘层压小，而之后没有任何事件再触发重排 → 立绘就"卡"在小尺寸。
     *  · 计时器实例上做覆盖保存，连续调用只会留下最后一次的两发，不会堆积。
     */
    _galLayoutSettle() {
      try { this._galLayout(); } catch (e) {}
      const w = this.win;
      const set = (fn, ms) => { try { return (w.setTimeout || setTimeout)(fn, ms); } catch (e) { return setTimeout(fn, ms); } };
      const clr = (id) => { if (!id) return; try { (w.clearTimeout || clearTimeout)(id); } catch (e) { try { clearTimeout(id); } catch (e2) {} } };
      clr(this._galT1); clr(this._galT2);
      this._galT1 = set(() => { try { this._galLayout(); } catch (e) {} }, 80);
      this._galT2 = set(() => { try { this._galLayout(); } catch (e) {} }, 300);
    },

    /**
     * 让位计算（每次显示前调用）：不靠写死的像素，直接量真实元素——
     *   · 底部：让出输入行（#chat-input-area）实际高度 + 间隙，输入框/发送/停止不被压住；
     *     间隙桌面 8px；**紧凑档不再让位**——常驻输入行已被移出布局（见 compactStyles ⑨），
     *     正文窗尺寸不变、整体下移贴底，底栏因此少掉整整一个输入行的高度；
     *   · 右侧：让出雷达列（.radar-panel 宽 + 边距），雷达不被压暗；无雷达时退回右侧列宽令牌；
     *     ⚠ 取「雷达实测」与「--right-col」的较大值：紧凑档右列收窄后雷达比令牌窄，
     *       直接按雷达算会让正文窗盖住中间那条「展开输入」竖条。
     */
    _galLayout() {
      try {
        const d = this.win.document;
        const layer = d.getElementById('gal-layer');
        if (!layer) return;
        const compact = this.body.classList.contains('ui-compact');
        // 密度切回桌面档时输入面板必须收起：桌面档没有竖条，留着就再也收不回去
        if (!compact && this._inputPopupOpen()) {
          const pop0 = d.getElementById('input-popup');
          const cc0 = d.getElementById('chat-container');
          const area0 = d.getElementById('chat-input-area');
          if (pop0) pop0.classList.remove('on');
          this.body.classList.remove('input-open');
          if (cc0 && area0 && area0.parentNode !== cc0) cc0.appendChild(area0);
        }
        const ia = d.getElementById('chat-input-area');
        let ih = 0;
        if (ia && ia.getBoundingClientRect) ih = Math.round(ia.getBoundingClientRect().height);
        if (compact) {
          layer.style.bottom = '0px';          // 紧凑档：贴底，不再让出输入行
        } else {
          const gap = 8;
          layer.style.bottom = ((ih > 0 ? ih : 58) + gap) + 'px';
        }
        let colW = 260;
        try {
          // 无雷达时退回「右侧列宽」令牌本身（桌面 260 / 紧凑档 176），不再写死 260 ——
          // 与 #chat-container 的 right 口径永远一致。
          const n = parseFloat(this.win.getComputedStyle(d.body).getPropertyValue('--right-col'));
          if (isFinite(n) && n > 0) colW = Math.round(n);
        } catch (e) {}
        let rw = colW;
        const radar = d.getElementById('radar-panel');
        if (radar && radar.getBoundingClientRect) {
          const rect = radar.getBoundingClientRect();
          if (rect && rect.width > 0) rw = Math.round(rect.width + 16);
        }
        layer.style.right = Math.max(rw, colW) + 'px';
      } catch (e) {}
      // 展开/收起按钮跟着底栏上沿走（紧凑档对话框比聊天面板高，必须一起重算）
      try { this._expandBtnLayout(); } catch (e) {}
      // 输入面板与正文窗同位置同尺寸：两边都变过，重贴一次
      try { this._layoutInputPopup(); } catch (e) {}
      // 立绘层让位：实测 gal 层真实位置，避免 calc 乘法兼容性与 min-height 差异
      try { this._psLayout(); } catch (e) {}
      // 诡意行商的「确认购买」盖板跟着雷达重贴（窗口/密度/全屏变化后雷达矩形会变）
      try { this._syncShopBuyBtnPos(); } catch (e) {}
    },

    // ============================================================================
    // 【窄屏输入面板】#input-strip ⟷ #input-popup（只有紧凑档显示，见 compactStyles ⑨）
    //   · 紧凑档把常驻输入行整行移出布局；要打字时点右下那条竖条，面板以**正文窗的实测矩形**
    //     为位置/尺寸滑出，输入行整块搬进去 —— 尺寸与位置和聊天界面完全一致，直接覆盖。
    //   · 收起 = 再点竖条 / 点面板右上角 ✕ / 任意一次发送成功（见 _commitPlayerMessage）。
    //   · 输入行是**搬移**不是复制：id、事件绑定、当前输入值、焦点全都只有一份，
    //     不会出现"两个发送按钮"或"发出去的是空值"。
    // ============================================================================

    /** 输入面板是否打开。 */
    _inputPopupOpen() {
      try {
        const p = this.win.document.getElementById('input-popup');
        return !!(p && p.classList.contains('on'));
      } catch (e) { return false; }
    },

    /**
     * 把输入面板贴到「正文窗」上：位置/尺寸 = #gal-layer 的实测矩形。
     * 正文窗还没有内容/被隐藏（矩形 0×0）时，按同一套口径自己算一个等价的框：
     * 左贴屏缘、右让出 --right-col、底贴屏缘、高 = max(屏高 30%, 112px)。
     */
    _layoutInputPopup() {
      try {
        const d = this.win.document;
        const pop = d.getElementById('input-popup');
        if (!pop || !pop.classList.contains('on')) return;
        const gl = d.getElementById('gal-layer');
        let box = (gl && gl.getBoundingClientRect) ? gl.getBoundingClientRect() : null;
        if (!box || !(box.width > 40) || !(box.height > 40)) {
          const H = Number(this.win.innerHeight) || 0;
          const W = Number(this.win.innerWidth) || 0;
          if (!(H >= 200) || !(W >= 200)) return;          // 视口退化：保留上一次的值
          let rw = 260;
          try {
            const n = parseFloat(this.win.getComputedStyle(d.body).getPropertyValue('--right-col'));
            if (isFinite(n) && n > 0) rw = n;
          } catch (e) {}
          const h = Math.max(Math.round(H * 0.30), 112);
          box = { left: 0, top: H - h, width: Math.max(120, Math.round(W - rw)), height: h };
        }
        const st = pop.style;
        st.left = Math.round(box.left) + 'px';
        st.top = Math.round(box.top) + 'px';
        st.width = Math.round(box.width) + 'px';
        st.height = Math.round(box.height) + 'px';
        st.right = 'auto'; st.bottom = 'auto';
      } catch (e) {}
    },

    /** 打开输入面板：搬入输入行 → 显示 → 按正文窗贴位 → 聚焦输入框。 */
    _openInputPopup() {
      try {
        const d = this.win.document;
        const pop = d.getElementById('input-popup');
        const area = d.getElementById('chat-input-area');
        if (!pop || !area) return;
        pop.appendChild(area);              // 搬移：id / 事件 / 当前输入值全部保留
        pop.classList.add('on');
        this.body.classList.add('input-open');
        this._layoutInputPopup();
        const inp = d.getElementById('chat-input');
        // 桌面浏览器里 iframe 可能不允许脚本抢焦点：取不到就算了，不影响手点
        if (inp && inp.focus) { try { inp.focus(); } catch (e) {} }
      } catch (e) {}
    },

    /** 收起输入面板：输入行搬回 #chat-container 末尾（紧凑档那里它是 display:none）。 */
    _closeInputPopup() {
      try {
        const d = this.win.document;
        const pop = d.getElementById('input-popup');
        const cc = d.getElementById('chat-container');
        const area = d.getElementById('chat-input-area');
        if (pop) pop.classList.remove('on');
        this.body.classList.remove('input-open');
        if (cc && area && area.parentNode !== cc) cc.appendChild(area);
      } catch (e) {}
    },

    /** 竖条点击：开 / 关。桌面档竖条不显示，这里再兜一层"非紧凑档直接返回"。 */
    toggleInputPopup() {
      try {
        if (!this.body.classList.contains('ui-compact')) return;
        if (this._inputPopupOpen()) this._closeInputPopup();
        else this._openInputPopup();
      } catch (e) {}
    },

    /**
     * 立绘同台层布局（实测）：底部锚点 = gal 层上沿 + 嵌入量(--ps-overlap) **再下移整屏 24%**
     * （立绘更大、贴地，不再浮空；上边缘不变，整体随下移同步缩放）。
     * 大号高度 = 底部锚点 − 顶栏高（顶到顶边栏）；小号 84% 由 .ps-slot 的 height:84% 负责。
     * 水平位置由 CSS 负责（left:0 ~ right:var(--right-col)，即聊天框宽度）。
     */
    _psLayout() {
      const d = this.win.document;
      const stage = d.getElementById('portrait-stage');
      if (!stage) return;
      // ⚠ 增稳闸 ①：视口退化（窗口最小化到 0、iframe 被父层隐藏、切到别的标签页）时 innerHeight
      //   会接近 0 —— 这一刻算出来的高度毫无意义，**直接不写**，保留上一次的正常值，
      //   免得把 120px 这种"合法但极小"的尺寸写进 stage，进而被 fit() 量成指甲盖立绘。
      const vh = Number(this.win.innerHeight) || 0;
      if (vh < 200) return;
      const gl = d.getElementById('gal-layer');
      const rect = gl && gl.getBoundingClientRect ? gl.getBoundingClientRect() : null;
      if (!rect || !rect.height) return;
      // ⚠ 增稳闸 ②：量到的对话框比整屏还高 / 上沿跑到屏外 → 说明正在换尺寸的中间态，不写。
      if (rect.height > vh || rect.top < -4) return;
      let overlap = 30;   // 与 CSS --ps-overlap 保持一致
      try { const o = parseFloat(this.win.getComputedStyle(d.body).getPropertyValue('--ps-overlap')); if (isFinite(o) && o >= 0) overlap = o; } catch (e) {}
      const drop = Math.max(0, Math.round(vh * 0.24));                     // 下移量：整屏 24%（作者拍板，可调）
      const bottomFromTop = rect.top + overlap + drop;                    // 立绘底部锚点（视口坐标）
      let barH = 48;
      try { const b = parseFloat(this.win.getComputedStyle(d.body).getPropertyValue('--bar-h')); if (isFinite(b) && b > 0) barH = b; } catch (e) {}
      // 防御钳制（正常值下 bft === bottomFromTop，零视觉变化；极端输入才介入）：
      //   · 下限 barH+120 —— 保证 h 取下限 120 时元素顶仍贴顶栏，**绝不顶出顶端**；
      //   · 上限 innerHeight-8 —— 底部锚点不侵入输入行，bottom 不会为负。
      // 由此 h = bft-barH 恒 ≥120（保留"不过小"下限），顶恒 = barH。
      const bft = Math.max(barH + 120, Math.min(bottomFromTop, vh - 8));
      stage.style.bottom = Math.round(vh - bft) + 'px';
      stage.style.height = Math.round(bft - barH) + 'px';
      // 槽位盒变了 → 让两个槽的图片按新盒重贴一次（这一步是"改窗口后立绘不恢复"的解药）
      try { PortraitStage.relayout(); } catch (e) {}
    },

    /**
     * 〘展开/收起按钮〙贴住「当前可见底栏」的上沿。
     *   桌面：完全由 CSS 决定（本条直接清掉 inline top，不动桌面口径）；
     *   紧凑档：对话框(gal)常常比聊天面板更高 —— 按聊天面板算的 top 会落进正文里盖住字，
     *          所以这里实测「对话框上沿」与「聊天面板上沿」，按钮贴到**更靠上**的那个的上沿。
     *          展开态(expanded)则以面板自身为准（此时对话框已收起）。
     * 调用点：_galLayout（显示/隐藏/密度切换/视口变化）与 toggleChatExpand（切换展开态）。
     */
    _expandBtnLayout() {
      try {
        const d = this.win.document;
        const btn = d.getElementById('chat-expand');
        if (!btn) return;
        if (!this.body.classList.contains('ui-compact')) { btn.style.top = ''; return; }
        const cc = d.getElementById('chat-container');
        const layer = d.getElementById('gal-layer');
        const box = d.getElementById('gal-box');
        const expanded = !!(cc && cc.classList.contains('expanded'));
        const galOn = !!(layer && layer.classList.contains('on'));
        let target = cc && cc.getBoundingClientRect ? cc.getBoundingClientRect().top : 0;
        if (!expanded && galOn && box && box.getBoundingClientRect) {
          const bt = box.getBoundingClientRect().top;
          if (bt > 0) target = target ? Math.min(target, bt) : bt;   // 取更高的那条上沿
        }
        const h = btn.offsetHeight || 22;
        const barH = parseFloat(this.win.getComputedStyle(d.body).getPropertyValue('--bar-h')) || 30;
        if (target > 0) btn.style.top = Math.max(Math.round(barH), Math.round(target) - h) + 'px';
      } catch (e) {}
    },

    /** 清空窗口（离开节点/回主城时调用，避免上一条正文残留在界面上）。 */
    _galClear() {
      this._galGroups = [];
      this._galIndex = -1;
      this._galSpeaker = '';
      this._galSyncedId = null;
      this._galMsgId = null;
      const el = this._galEls();
      if (el.body) el.body.innerHTML = '';
      if (el.pager) el.pager.textContent = '';
      if (el.next) el.next.classList.remove('on');
      if (el.back) el.back.classList.remove('on');
      if (el.name) { el.name.textContent = ''; el.name.classList.add('off'); }
      if (el.ava) { el.ava.removeAttribute('src'); el.ava.classList.remove('on'); }
      try { PortraitStage.clear(); } catch (e) {}
      this._galShow(false);
    },

    /** 画某一段的头像与名牌（新协议）：以本段末尾 {} 指向角色为锚，**每段重新读取、不沿用上一段**；
     *  无锚点 → 头像无 + 名牌无 + 立绘全暗；下次出现角色名再点亮/更新对应头像与立绘。
     *  旧格式（无 {} 锚点）回退用本段 <名字>（chs[0]），同样不做沿用。 */
    _galApplySpeaker(g) {
      const el = this._galEls();
      const own = (g && g.anchor && g.anchor.key) || ((g && g.chs && g.chs[0]) || '');
      const nm = own;                       // ⚠ 无沿用：每段读自己的锚点，空则空
      this._galSpeaker = nm;
      if (el.name) {
        if (nm) { el.name.textContent = nm; el.name.classList.remove('off'); }
        else { el.name.textContent = ''; el.name.classList.add('off'); }
      }
      if (el.ava) {
        if (nm) {
          // 头像按"图源基底名"取：标本键 / 改名后的标本名都能落到正确的角色（头像本身不区分异构体）
          const base = (g && g.anchor && g.anchor.base)
            || _portraitBaseFor(nm, (_findPortraitRecord(readVars(this.win), nm) || {}).记录);
          const src = opAva(base);
          if (el.ava.getAttribute('src') !== src) el.ava.src = src;
          el.ava.classList.add('on');
        } else {
          el.ava.removeAttribute('src');
          el.ava.classList.remove('on');
        }
      }
      // 立绘同台：说话人（含后缀原名如 星源_ei/凯尔希_大老婆）驱动舞台点亮；空锚点 → 全暗（PortraitStage 内处理）
      try { PortraitStage.add(nm, this.win); } catch (e) {}
    },

    /** 更新「第 n/m 页」角标与两个翻页箭头的亮灭。 */
    _galPager() {
      const el = this._galEls();
      const n = this._galIndex + 1;
      const m = this._galGroups.length;
      if (el.pager) el.pager.textContent = m > 1 ? (n + ' / ' + m) : '';
      if (el.next) el.next.classList.toggle('on', m > 1 && n < m);
      if (el.back) el.back.classList.toggle('on', n > 1);
    },

    /** 直接整页显示（无任何延时）：第 i 页 = groups[i] 的全文。 */
    _galShowPage(i) {
      const el = this._galEls();
      if (!el.layer) return;
      const groups = this._galGroups || [];
      if (i < 0 || i >= groups.length) return;
      this._galIndex = i;
      const g = groups[i];
      this._galApplySpeaker(g);
      if (el.body) el.body.innerHTML = '<div class="gal-grp">' + this._galGroupHTML(g.text) + '</div>';
      this._galPager();
    },

    /** 加载一条正文：切好全部页并回到第 1 页。返回是否真的有页可看。 */
    _galLoad(text, id) {
      let groups = [];
      try { groups = this._galSplitGroups(text) || []; } catch (e) { groups = []; }
      if (!groups.length) return false;
      this._galGroups = groups;
      this._galIndex = -1;
      this._galSpeaker = '';
      this._galMsgId = id;
      this._galShowPage(0);
      return true;
    },

    /** 启动一条新正文（appendChat 命中"最新一条 AI 消息"时调用）。 */
    _galPlay(text, id) {
      const ok = this._galLoad(text, id);
      if (!ok) return false;
      // 展开态＝正在看「对话记录」：照常排好页但不弹窗；收起面板时会显示出来。
      this._galShow(this._galVisible());
      this._galSyncedId = id;   // 记住"这条已加载"，收起再展开时不要重置页数
      return true;
    },

    /** 单击聊天窗口＝翻下一页；已是最后一页则无动作。 */
    _galNext() {
      if (!this._galVisible()) return;
      const groups = this._galGroups || [];
      if (!groups.length) return;
      if (this._galIndex + 1 < groups.length) this._galShowPage(this._galIndex + 1);
    },

    /** 左下角箭头＝回上一页；已是第 1 页则无动作。 */
    _galPrev() {
      if (!this._galVisible()) return;
      if (this._galIndex > 0) this._galShowPage(this._galIndex - 1);
    },

    /**
     * 【自检】把 Galgame 窗口的真实运行状态打到控制台。
     * 入口：游戏界面里按 Shift+G。
     * 排查三类问题一眼够用：① 层是否存在/是否显示；② 当前有几段、停在第几段；
     * ③ 正文节点里到底有没有字（"打字打完了却空白"基本都能在这里定位）。
     */
    _galDebug() {
      const d = this.win.document;
      const el = this._galEls();
      const cc = d.getElementById('chat-container');
      const dump = {
        层存在: !!el.layer,
        层class: el.layer ? el.layer.className : '(无)',
        层display: (el.layer && this.win.getComputedStyle) ? this.win.getComputedStyle(el.layer).display : '(无)',
        层高度: (el.layer && el.layer.getBoundingClientRect) ? Math.round(el.layer.getBoundingClientRect().height) : '(无)',
        层在root内: !!(el.layer && el.layer.parentNode && el.layer.parentNode.id === 'root'),
        正文元素: !!el.body,
        正文字数: el.body ? String(el.body.textContent || '').length : 0,
        正文开头: el.body ? String(el.body.textContent || '').slice(0, 100) : '(无)',
        名牌: el.name ? el.name.textContent : '(无)',
        说话人: this._galSpeaker,
        总页数: (this._galGroups || []).length,
        当前页: this._galIndex >= 0 ? (this._galIndex + 1) : 0,
        对齐到消息: this._galSyncedId,
        窗口应为可见: this._galVisible(),
        对话记录展开: !!(cc && cc.classList.contains('expanded')),
        干员开关: (() => { // jczl_custom_switch 开关筛网状态（Shift+G 排查用）
          try {
            const c = readSwitchTable();
            const off = CUSTOM_NAMES.filter((nm) => c[nm] === false);
            const cache = _switchCache || {};
            return '禁用 ' + off.length + ' / ' + CUSTOM_NAMES.length
              + (off.length ? '（' + off.slice(0, 6).join('、') + (off.length > 6 ? '…' : '') + '）' : '')
              + ' · 存于 ' + switchScope() + (cache.migrated ? '（本次已从旧聊天变量迁移）' : '');
          } catch (e) { return '(读取失败)'; }
        })(),
        ...viewportInfo(this.win),   // 视口/DPR/触屏/密度 + 关键容器实测尺寸（手机端排版排查用）
      };
      console.info('[集成战略] Galgame 自检：', dump);
      return dump;
    },

    /**
     * 【自检】界面密度：循环 自动 → 桌面 → 紧凑，持久化到 localStorage（jczl.uiDensity）。
     * 入口：游戏界面里按 Shift+M。只切 CSS 类，不动任何数据。
     * 紧凑档会改地图节点尺寸 → 切换后补一次箭头重绘（否则 SVG 连线会按旧坐标错位）。
     */
    _cycleUiDensity() {
      const win = this.win;
      const cur = readUiDensityPref(win);
      const next = cur === 'auto' ? 'desktop' : (cur === 'desktop' ? 'compact' : 'auto');
      writeUiDensityPref(win, next);
      setViewportVars(win);
      applyUiDensity(win);
      try { this._galLayout(); } catch (e) {}   // 输入行高度随密度变 → gal 让位重量一次
      if (State.currentStatus === 'map_navigation' && State.mapCache) {
        try { this._drawMapLinks(State.mapCache); } catch (e) {}
      }
      const dump = viewportInfo(win);
      console.info('[集成战略] 界面密度已切换：', dump);
      return dump;
    },

    /** 静态铺开（历史回看用）：加载全部页并停在 **第 1 页**。 */
    _galShowStatic(text) {
      return this._galLoad(text, null);
    },

    /** 收起窗口时：把正文恢复到「最近一条**有可见正文**的 AI 消息」。
     *  ⚠ 不能只看最后一条：AI 回复可能是"纯思考/纯隐藏标签"（<thinking>/[metacognition] 等，
     *  清洗后是 ◇）—— 最后一条是这种时，要回退到上一条真正有正文的回复。
     *  ⚠ 每个"不加载"分支都会打日志（最多一次），排查窗口空白直接看控制台。 */
    _galSyncFromHistory() {
      const clean = State.chatClean || [];
      const galLog = (msg) => { if (!this._galDbgOnce) { this._galDbgOnce = true; console.info('[集成战略] sync 未加载：' + msg); } };
      let last = null;
      let lastAny = null;   // 兜底：连一条有正文的都没有时，取最后一条 ai（哪怕是 ◇）
      // ⚠ role 判断必须认 'ai'：清洗后（_cleanRawTextForDisplay）assistant 都变成了 'ai'。
      for (let i = clean.length - 1; i >= 0; i--) {
        const m = clean[i];
        if (m.role !== 'ai' && m.role !== 'assistant') continue;
        if (!lastAny) lastAny = m;
        const t = String(m.text || '').trim();
        if (t && t !== '◇') { last = m; break; }
      }
      if (!last) {
        if (lastAny) {
          // 所有 AI 回复都没有可见正文：退而显示最后一条的占位，绝不假装"加载成功"
          galLog('没有任何 AI 回复有可见正文（最后一条 role=' + lastAny.role + '，text 前20字="' + String(lastAny.text || '').slice(0, 20) + '"）');
        } else {
          galLog('聊天里没有 AI 消息（role 只找到 ' + clean.map((x) => x.role).join(',') + '）');
        }
        this._galClear();
        this._galSyncedId = null;
        return;
      }
      const ltxt = String(last.text || '').trim();
      // 同一条正文正在播/已播完 → 忍住别重铺，否则收起再展开会把进度重置回第 1 段。
      // （新一条 AI 回复的 id 不同，自然会走下面的重铺路径。）
      if (this._galSyncedId != null && this._galSyncedId === last.id && (this._galGroups || []).length) {
        this._galShow(this._galVisible());
        return;
      }
      const ok = this._galShowStatic(ltxt);
      if (!ok) { galLog('_galSplitGroups 切不出页（text 前40字="' + ltxt.slice(0, 40) + '"）'); }
      this._galSyncedId = last.id;
      this._galShow(this._galVisible());
    },

    /**
     * 直连兜底：不复用 State.chatClean，**直接从套接口 getChatMessages(-1) 现场取**最新一条
     * 有可见正文的 AI 消息（_extractContent 提取 <content> 块）填充窗口。
     * 只要脚本是新版、消息里真有 <content>（或兜底剥标签后的正文），这里就一定能出字。
     * 独立于 loadHistoryChat / 清洗缓存的任何时序问题。
     */
    _galLoadLatest() {
      try {
        if (!this.win.getChatMessages) return false;
        const msgs = this.win.getChatMessages(-1) || [];
        if (!msgs || !msgs.length) return false;
        let found = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role !== 'assistant') continue;
          // 正文唯一口径（剥思考/摘要/变量 → 切选项 → 清残留标签；保留 <名> 与 {锚点}）
          const t = this._extractBodyAndOptions(m.message || '').body.trim();
          if (t && t !== '◇') { found = { id: m.message_id, text: t }; break; }
        }
        // 取不到正文是"这条 AI 回复没有可见内容"，属于正常情况（不刷日志）；
        // 需要排查时按 Shift+G 看窗口自检。
        if (!found) return false;
        // 同一条已加载过 → 保持当前页，不重置
        if (this._galSyncedId === found.id && (this._galGroups || []).length) {
          this._galShow(this._galVisible());
          return true;
        }
        const ok = this._galShowStatic(found.text);
        if (ok) {
          this._galSyncedId = found.id;
          this._galShow(this._galVisible());
        }
        return ok;
      } catch (e) {
        console.warn('[集成战略] Galgame 直连加载失败：', e && e.message);
        return false;
      }
    },

    /** 极简 Markdown（帮助气泡不像日志）。展开态聊天记录 / 非打字场景仍用它。 */
    _md(text) {
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // 记录显示视图：说话人标签在转义前统一脱壳（<夏莲>「…」→ 夏莲「…」），
      // 名字保留；分段引擎（_galSplitGroups）用的是未脱壳原文，两者互不干扰。
      const src = this._galStripNameTags(text);
      return (src || '').split('\n').map((raw) => {
        let line = esc(raw.trim());
        if (!line) return;
        line = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
        if (/^####?\s+/.test(line)) return `<p class="md-head">${line.replace(/^####?\s+/, '')}</p>`;
        if (/^>\s?/.test(line)) return `<p class="md-quote">${line.replace(/^>\s?/, '')}</p>`;
        return `<p>${line}</p>`;
      }).filter(Boolean).join('');
    },

    _editMsg(id) {
      if (!this.win.getChatMessages) return;
      const m = this.win.getChatMessages(id)[0];
      if (!m) return;
      const cur = m.message;
      // 紧凑档：常驻输入行在隐藏态（在 #input-popup 里）—— 先把面板弹出来，否则改了也看不见
      try {
        if (this.body.classList.contains('ui-compact') && !this._inputPopupOpen()) this._openInputPopup();
      } catch (e) {}
      const src = this.win.document.getElementById('chat-input');
      src && (src.value = cur);
      src && src.focus();
      State.pendingEditId = id;
      const send = this.win.document.getElementById('chat-send');
      if (send) send.textContent = '保存';
    },

    _delMsg(id) {
      this._uiConfirm('删除该消息会回退其携带的数据，确定？', '删除消息').then((ok) => {
        if (!ok) return;
        if (!this.win.deleteChatMessages) return;
        this.win.deleteChatMessages([id]).then(() => this.loadHistoryChat());
      });
    },

    /**
     * 重roll：输入框旁的 ↻ 按钮（记录内的 🔄 已移除）。
     *  · 最后一条是 AI 消息 → 删除该楼及其后的所有楼层，重新触发回复；
     *  · 最后一条是用户消息 → 不删楼，直接触发回复（等效"继续"）。
     * ⚠ 删楼后的变量一致性：本游戏变量依赖 AI 回复里的 <update> 标签增量写入，
     * 删楼会让这些改动"蒸发"，而持久化快照里还是旧值——删楼后强制重读最新快照、
     * 刷新统计与长期池，避免界面上变量与楼层对不上而崩（编队空/数值异常等）。
     */
    handleReroll() {
      if (State.busyPhase === 'generating') return;          // 生成中禁止重roll
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      if (!this.win.getChatMessages || !this.win.deleteChatMessages) return;
      const msgs = this.win.getChatMessages('0-{{lastMessageId}}') || [];
      if (!msgs.length) return;
      const last = msgs[msgs.length - 1];
      const lastIsAI = last.role === 'assistant' || last.role === 'ai';
      const msg = lastIsAI
        ? '删除最后一条 AI 回复及其后的楼层并重新生成？\n（相关楼层携带的变量改动会回滚到上一份快照）'
        : '最后一条是玩家消息，将直接触发一次新回复（不删楼）。';
      this._uiConfirm(msg, '重新生成').then((ok) => {
        if (!ok) return;
        const proceed = () => {
          // 删楼/重生成后：重读聊天 + 变量重算，防止删楼导致状态错乱
          try { this.loadHistoryChat(); } catch (e) {}
          try { this._recomputeLongPool(); } catch (e) {}
          try { this.refreshStats(); } catch (e) {}
          State.armed = true; State.armedAt = Date.now();  // 重roll 是主动触发：白名单置位
          State.pendingNoBusyUntil = 0;   // 清零忽略窗口，放行随后的 STARTED
          if (this.win.triggerSlash) this.win.triggerSlash('/trigger').catch(() => {});
        };
        if (!lastIsAI) { proceed(); return; }
        const ids = msgs.filter((m) => m.message_id >= last.message_id).map((m) => m.message_id);
        this.win.deleteChatMessages(ids).then(proceed).catch(() => proceed());
      });
    },

    bindChatEvents() {
      const send = this.win.document.getElementById('chat-send');
      if (send) send.onclick = () => this.handleSend();
      const input = this.win.document.getElementById('chat-input');
      if (input) input.onkeydown = (e) => { if (e.key === 'Enter') this.handleSend(); };
      // ── Galgame 翻页：点「对话框本体」＝翻下一页 ──
      //   热区 = #gal-box（所见即所点，不再有"框外也能翻"的错位）；
      //   箭头躺在框内并 stopPropagation，点箭头只走各自的上一页/下一页。
      const gbox = this.win.document.getElementById('gal-box');
      if (gbox) gbox.onclick = (e) => { e.stopPropagation(); this._galNext(); };
      // 右下角「下一页」提示（透明层已覆盖，双保险）
      const gnext = this.win.document.getElementById('gal-next');
      if (gnext) gnext.onclick = (e) => { e.stopPropagation(); this._galNext(); };
      // 左下角「上一页」箭头：点击回上一页（它也躺在点击层之上，不会同时触发翻下一页）
      const gback = this.win.document.getElementById('gal-back');
      if (gback) gback.onclick = (e) => { e.stopPropagation(); this._galPrev(); };
      // 展开态＝「对话记录」：点历史区不翻页（真正翻页在 #gal-box 上；展开时该层已隐藏）
      const hist = this.win.document.getElementById('chat-history');
      if (hist) {
        hist.onclick = (e) => {
          const cc = this.win.document.getElementById('chat-container');
          if (cc && cc.classList.contains('expanded')) return;
          if (e.target && e.target.closest && e.target.closest('.msg-controls, .chat-more-btn')) return;
          this._galNext();
        };
      }
      // 黄色箭头（旧聊天框里的那个）同样当「下一页」
      const arrow = this.win.document.getElementById('gal-arrow');
      if (arrow) {
        arrow.onclick = (e) => {
          e.stopPropagation();
          this._galNext();
        };
      }
      // 聊天面板顶上那颗展开按钮：只包装一次（避免重复包导致行为叠加/失效）
      const exp = this.win.document.getElementById('chat-expand');
      if (exp && !exp.dataset.galWrapped) {
        exp.dataset.galWrapped = '1';
        const old = exp.onclick;
        exp.onclick = (e) => {
          if (this._galVisible()) this._galShow(false);
          if (typeof old === 'function') old.call(exp, e);
        };
      }
      // ── 重roll：输入框旁（任务5）。最后一条是 AI → 删楼重生成；是用户 → 直接触发回复 ──
      const rerollBtn = this.win.document.getElementById('chat-reroll');
      if (rerollBtn) rerollBtn.onclick = () => this.handleReroll();
      // 初始归一：中止按钮进入既有两态（「■」暗·禁用），避免初始 HTML 出现"■ 停止"第三态
      this._applyBusyLock();
    },

    /**
     * █ 统一「玩家消息」发送出口（确认后、发送前）：
     *   - 战报触发：以最终正文（选项标题/选项简介/输入框原文/草稿）命中「进入一场特殊的战斗」且当前为不期而遇节点为唯一依据；
     *     只在确认回调内执行一次——两段式选项的「展开」与用户来回犹豫不进入本方法，杜绝重复拼装。
     *   - 拼装时机：此刻 vars 为最近一次 AI 回复处理后的最新值，战报不过期；
     *   - 异步边界：await createChatMessages 完成后再 triggerSlash（战报先落进消息再触发回复）；
     *   - 守卫：pendingSend 置位期间拒绝再次进入（双击/连点兜底）。
     */
    _commitPlayerMessage(rawBase) {
      if (State.pendingSend) return;                       // 双击/连点守卫
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      State.pendingSend = true;
      // 窄屏输入面板：一次发送成功就收起（输入行搬回底部），把正文窗整块让回来
      try { this._closeInputPopup(); } catch (eClose) {}
      State.armed = true; State.armedAt = Date.now();      // 白名单：本端发起，等待 STARTED 认领
      State.pendingNoBusyUntil = 0;                        // 清零忽略窗口，放行随后的 GENERATION_STARTED
      let raw = rawBase;
      // 变奏收束态：每条出站消息前置"额外探索已耗尽"预填充战报（<eventp> 隐藏区，仅 AI 可见）
      raw = this._withExploreLock(raw);
      // 重玩模式：本回合若纠正过越权改动，前置"前文可能出错，已修复"的隐藏说明（只发一次）
      raw = this._withReplayFix(raw);
      try {
        // 无对手不开战：不期而遇有 50% 概率无目标角色，此间不存在可打的人 →
        // 即便文本命中关键词也不拼战报（否则会生成一张"没有对手"的空战报）。
        // 收束态同样不开战：额外探索已耗尽，玩家手打关键词也不能再往前端塞一场新战斗。
        if (BATTLE_KEYWORD_RE.test(raw) && this._nodeHasTarget() && this._isUnexpectedNode() && !this._nodeExploreExhausted()) {
          const rep = this._computeBattleReport();
          if (rep) raw += '\n' + this._sys(rep);
        }
      } catch (e) {}
      // 乐观回显：玩家气泡只显示可读正文（剥离 eventp/隐藏标签），完整原文（含 System）写入楼层给 AI。
      const shown = this._stripEventp(this._stripHiddenTags(raw)).trim() || '◇';
      this.appendChat('user', _userName || '你', shown, null);
      // 右上角玩家气泡立即更新（选项/发送输入一确认就变，不等 AI 回复）
      try { this.renderLastUserBubble(shown); } catch (e2) {}
      const done = () => { State.pendingSend = false; };
      if (this.win.createChatMessages) {
        return this.win.createChatMessages([{ role: 'user', name: getUserName(), message: raw }])
          .then(() => {
            done();
            if (this.win.triggerSlash) return this.win.triggerSlash('/trigger').catch(() => {});
          })
          .catch((e) => { done(); console.warn('[集成战略] 发送失败', e && e.message); });
      }
      if (this.win.triggerSlash) {
        done();
        return this.win.triggerSlash(`/send ${raw}`).catch(() => {});
      }
      done(); // 开发模式：仅本地气泡
      return Promise.resolve();
    },

    handleSend() {
      if (State.busyPhase === 'generating') return;        // 思考中禁止发送（按钮已置灰，此处双保险）
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      const input = this.win.document.getElementById('chat-input');
      const text = input ? input.value.trim() : '';
      if (!text) return;
      const target = this.win.document.getElementById('target-selector').value;
      const prefix = target ? `[注视着 ${cleanName(target)}] ` : '';
      // 节点收束锁定：只能离开（调试类操作不受影响）
      if (this._nodeLocked()) { this.win.alert('本节点已收束，只能离开。'); return; }

      // 编辑模式：保存并退出
      if (State.pendingEditId != null && this.win.setChatMessages) {
        const rawWithTag = text;
        this.win.setChatMessages([{ message_id: State.pendingEditId, message: rawWithTag }]).then(() => {
          State.pendingEditId = null;
          const s = this.win.document.getElementById('chat-send');
          if (s) s.textContent = '发送';
          this.loadHistoryChat();
        });
        input.value = '';
        return;
      }

      input.value = '';
      // 正式模式：写真实消息 + 触发 AI；开发模式：仅本地气泡
      // 统一出口：关键词命中自动拼战报（确认后、发送前），再回显提交触发
      let fullMsg = `${prefix}${text}`;
      if (State.pendingLeaveNote) { fullMsg = State.pendingLeaveNote + '\n' + fullMsg; State.pendingLeaveNote = ''; }
      this._commitPlayerMessage(fullMsg);
    },

    /**
     * 收到 AI 回复后的统一入口：刷新历史 + 解析正文 <action_options> 渲染选项。
     * 完全通用：无论处于主城/地图/节点，只要 AI 正文给出 <action_options> 就显示为底部选项。
     */
    _handleAiReply() {
      // 重玩模式兜底：AI 越权改了经济/收藏品/蚀刻章，或新收干员不是活化 → 立刻纠正，
      // 并在下一条出站消息前置一段隐藏说明（见 _withReplayFix）。必须放在一切读变量之前。
      try { this._replayDriftCheck(); } catch (e) {}
      this._recomputeLongPool(); // AI 可能刚写入新收藏品/改数值 → 先重算长期池
      // 失败判定：AI 回复即扣减核心生命的唯一时机。≤0 → 进入**失败锁定态**（冻结操作、留在聊天界面）。
      // ⚠ 失败后**仍然要刷新正文**（那句把人打死的叙述玩家得看得见），只是不再做节点推进类处理、
      //   也不再渲染选项栏 —— 所以这里不能用"直接 return 跑路"的写法。
      const failed = this._checkRunFailed();
      if (!failed) {
        this._auditNodeVariant();  // 变奏审计：本节点收服第二个角色 → 置 $变奏用尽（此后只能纯交流，由玩家自行离开）
        this._updateNodeLeaveGate(); // 战斗节点收服主目标后补出离开卡（未通关不出现）
        this._syncEtchBadges();      // 蚀刻章：编队/遭遇都由变量驱动，每次回复后兜底判定（幂等，已有则不触发）
      }
      this._syncPromoteSentence();  // 晋升报价自愈：AI 误删/写坏 `_探索进程._晋升花费` 时立刻按当前难度补回（幂等）
      this.refreshStats();         // 顶栏数值 + 层数罗马数字 + 常驻右下角三轴雷达（节点内外均按最新值刷新）
      this.loadHistoryChat();      // 失败态也要跑：让"最后一击"的正文出现在聊天窗 / gal 里
      if (failed) return;          // 失败态：不再渲染选项（已锁，且输入框只读）
      try {
        const latest = this.win.getChatMessages ? this.win.getChatMessages(-1) : null;
        const last = latest && latest.length ? latest[latest.length - 1] : null;
        if (last && (last.role === 'assistant' || last.role === 'ai')) this._parseActionOptions(last.message || '');
      } catch (e) {}
    },

    _parseActionOptions(raw) {
      const clear = () => {
        const r = this.win.document.getElementById('option-rail');
        if (r) r.remove();
        this.body.classList.remove('has-option-rail');
        // 诡意行商：购买面板**常驻**（它盖在三轴雷达上，撤掉雷达就会露出来），只切回待机态；
        // 其它节点：商品卡一起收掉时，「确认购买」也一起撤（本来也不会存在）。
        if (this._shopNodeNow()) this._shopRefreshBuyCaption();
        else this._removeShopBuyBtn();
      };
      // 收束（$锁定）态：正文选项与输入一律锁死，选项栏只渲染「离开节点」卡（本节点唯一出口是离开）
      if (this._nodeLocked()) {
        const r = this.win.document.getElementById('option-rail');
        if (r) r.remove();
        this.body.classList.remove('has-option-rail');
        this._removeShopBuyBtn();
        this._ensureLeaveCard();
        return;
      }
      const leave = this._showLeaveCard();   // 节点内是否渲染离开卡（战斗未通关 / 诡意行商 / 非节点视图 = false）
      // 诡意行商：本节点唯一的"购物模式"开关 —— 选项＝商品可多选，发送交给右下角「确认购买」按钮。
      const shop = this._shopNodeNow();
      // 选项来源唯一口径（三通道）：<action_options> → 【选项】标记 → 裸编号靠后块。
      // ⚠ 与显示层共用 _extractBodyAndOptions，绝不再单独 regex 一遍（否则两边口径会分叉）。
      const items = this._extractBodyAndOptions(raw || '').items;
      // 离开入口统一由前端合成卡承担：AI 若仍输出「多一事不如少一事」（旧世界书）或离开别名选项，
      // 显示层一律剥除（宽容匹配见 isLeaveOption），避免双卡；拦截分支保留作兜底——万一漏网，点击仍等效离开。
      const keep = items.filter((it) => !isLeaveOption(it));
      if (!keep.length && !leave) { clear(); return; }
      // 隐藏关硬保证：本节点命中隐藏世界线时**只渲染第一个选项**，
      // 不指望 AI 一定听话（战报已要求"只能一个"，这里再兜一层，界面不会多给分支）。
      // ⚠ 截断只作用于正文选项；离开卡在截断**之后**追加，不会被裁掉（隐藏线仍需离开出口）。
      const sliceNow = (readVars(this.win)['$切片'] || {});
      if (sliceNow.$隐藏关 && keep.length) keep.length = Math.min(keep.length, 1);
      let rail = this.win.document.getElementById('option-rail');
      if (!rail) {
        rail = this.win.document.createElement('div');
        rail.id = 'option-rail';
        this.win.document.body.appendChild(rail);
      }
      rail.innerHTML = '';
      keep.forEach((it) => {
        const b = this.win.document.createElement('button');
        b.className = 'opt-card';
        b.innerHTML = (it.n + '. ' + it.title) + (it.desc ? '<span class="d">' + it.desc + '</span>' : '');
        if (shop) {
          // ── 诡意行商：多选商品（点一次勾上 / 再点一次取消），不展开、不单独发送 ──
          b.setAttribute('data-shop-item', '1');
          b.__shopItem = it;   // 供 _shopPickedItems 取回 {n,title,desc}（同一 iframe 内活对象，无需序列化）
          b.onclick = () => this._shopToggleItem(b);
        } else {
          b.onclick = () => {
            const ex = rail.querySelector('.opt-card.expanded');
            if (ex && ex === b) {
              this._pickActionOption(it); // 再点 → 确认发送
              clear();
            } else {
              if (ex) ex.classList.remove('expanded');
              b.classList.add('expanded'); // 展开确认态（互斥）
            }
          };
        }
        rail.appendChild(b);
      });
      if (leave) this._appendLeaveCard(rail);   // 离开卡恒排末尾（若 _showLeaveCard）
      this.body.classList.add('has-option-rail');
      // 诡意行商：勾选是新一轮的（整栏刚重建）→ 清掉残留的"离开已选中"、解除"已提交"待机态，
      // 并保证「确认购买」按钮在位：它整块盖在右下角三轴雷达上（_syncShopBuyBtnPos 实测矩形），
      // 因此玩家在诡意行商里始终看不到雷达。
      if (shop) {
        this._shopClearLeavePick();
        this._shopPending = false;
        this._ensureShopBuyBtn();
      } else {
        this._removeShopBuyBtn();   // 非诡意行商：兜底摘掉（正常换节点时 switchView 已摘）
      }
    },

    /**
     * 点击选项：把所选文本作为 user 消息发出（可附上输入框内尚未发送的个人输入），触发 AI。
     * 效果由 AI 收到后自行修改变量（前端不再执行任何效果）。
     */
    _pickActionOption(it) {
      if (this._nodeLocked()) return;
      if (State.failed) return;                                 // 失败锁定态：冻结一切会改变对局的操作（唯一出口＝返回罗德岛）
      if (State.busyPhase === 'generating') return;        // 思考中禁止选选项（含离开卡拦截路径）
      // 离开契约：标题/简介命中"离开"语义（isLeaveOption：契约句包含匹配 + 保守别名，
      // 兼容旧世界书 AI 的带标点/换行/别名变体；前端合成卡也走此判定）→ 等效于离开本节点。
      // 必须在一切发送副作用（读草稿/拼消息/清输入框/拼战报）**之前**拦截并 return，
      // 拦干净：不留下任何"发送该选项"的残留。
      if (isLeaveOption(it)) {
        // 收服前锁定：与离开门控同口径（_nodeCanLeave），此时既不离开也不发送该选项
        if (this._nodeCanLeave()) {
          this._leaveNode();
        } else {
          try { if (this.win && this.win.alert) this.win.alert('作战节点需先了结此间主目标'); } catch (e) {}
        }
        // 清掉选项栏（leave 已切视图，避免残留可点卡片）
        const r = this.win.document.getElementById('option-rail');
        if (r && r.parentNode) r.parentNode.removeChild(r);
        this.body.classList.remove('has-option-rail');
        return;
      }
      const input = this.win.document.getElementById('chat-input');
      const draft = input ? (input.value || '').trim() : '';
      let msg = draft ? `(玩家输入: ${draft})\n【选择】${it.title}` : `【选择】${it.title}`;
      // 战报触发契约（世界书：招惹选项的「简介」= 触发信号）：
      // 简介命中触发词时并入消息 —— 否则 _commitPlayerMessage 只见标题、拼不出战报（历史缺口，已修）。
      if (it.desc && BATTLE_KEYWORD_RE.test(String(it.desc))) {
        msg += '\n（简介：' + String(it.desc).trim() + '）';
      }
      if (State.pendingLeaveNote) { msg = State.pendingLeaveNote + '\n' + msg; State.pendingLeaveNote = ''; }
      if (input) input.value = '';
      // 统一出口：标题/简介/草稿命中关键词自动拼战报（二次确认后、发送前），再回显提交触发
      this._commitPlayerMessage(msg);
    },

    /**
     * 收到 AI 回复后的正文选项解析入口。
     * (P3 新格式) 将解析正文 <action_options>：忽略 System: 前缀行、编号条目渲染为可点选项，
     * 点击后连同玩家输入作为 user 消息发出。当前阶段先空置，解析器在后续接线阶段接入。
     */


    _goto(target) {
      if (target === 'preparation') this.switchView('preparation');
      else if (target === 'map') this.switchView('map_navigation');
      else if (target === 'event_node') this.switchView('event_node');
    },

  };

  /**
   * 新建干员时填满的 OperatorSchema。前端只负责把全部字段置为「待初始化」占位，
   * 具体设定/经历/态度交由 AI 后续通过变量修改完善。
   */
  function makeEmptyOperator(reason) {
    return {
      状态: '侵蚀',
      外貌特征: { 年龄: '待初始化', 身体特征: '待初始化', 服装描述: '待初始化' },
      色情设定: { 敏感部位: '待初始化', 名器特点: '待初始化', 淫化表现: '待初始化' },
      经历记录: reason ? { 招募: reason } : {},
      对玩家的态度: '待初始化',
      已晋升: false,
    };
  }

  const Engine = {
    _emitReport(win, text) {
      const main = win.document.getElementById('main-content');
      if (!main) return;
      // 在棋盘上方插入战报条（轻量，不持久化聊天）
      const tag = win.document.createElement('div');
      tag.className = 'battle-report';
      tag.innerHTML = `<pre>${text}</pre>`;
      tag.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);max-width:80%;z-index:60;background:rgba(0,0,0,0.85);border:1px solid #666;border-radius:8px;padding:10px 14px;font-size: max(11px, calc(12px + var(--fs-d, 0px)));line-height:1.6;color:#eee;';
      main.appendChild(tag);
      // 5 秒后自动移除（正式版改发聊天）
      setTimeout(() => { if (tag.parentNode) tag.remove(); }, 6000);
    },

    async _sendAsUser(win, text, doTrigger = true) {
      // 收集前端聊天框草稿并清空
      let combined = text || '';
      State.armed = true; State.armedAt = Date.now();      // 白名单：本端发起，等待 STARTED 认领
      State.pendingNoBusyUntil = 0;                        // 清零忽略窗口，放行随后的 STARTED
      let draft = '';
      try {
        const input = win.document && win.document.getElementById('chat-input');
        if (input) {
          draft = (input.value || '').trim();
          if (draft) combined = `(玩家输入: ${draft})\n` + combined;
          input.value = ''; // 清空前端聊天框
        }
      } catch (e) {}
      // 变奏收束态：前端系统战报同样前置预填充（离开节点后 `$变奏用尽` 复位，自然不再前置）
      combined = Router._withExploreLock(combined);
      // 草稿命中战斗关键词：确认后、发送前拼战报（与玩家发送出口同规则，System 路径兜底不遗漏）
      // 同样加"无对手不开战"守卫：不期而遇无目标角色时，此间没有可打的人。
      // 收束态也不再拼战报（额外探索已耗尽，不得靠关键字再塞一场新战斗）。
      if (draft && BATTLE_KEYWORD_RE.test(combined) && Router._nodeHasTarget() && Router._isUnexpectedNode() && !Router._nodeExploreExhausted()) {
        try {
          const rep = Router._computeBattleReport();
          if (rep) combined += '\n' + Router._sys(rep);
        } catch (e) {}
      }
      // 发送前同步隐藏关变量（f→t）：此刻 MVU 必然已提交 AI 上一轮的变量写入，
      // 于是紧接着这次生成读到的 EJS 一定能看到 t —— 不赌"MESSAGE_RECEIVED 与 MVU 谁先跑"。
      try { Router._syncHiddenFlags(); } catch (e) {}
      // 触发回复前持久化（战斗/按钮行动都会先落盘）
      Router._persistGameState(win);
      // 乐观回显：让这条"进节点/战报 user 消息"立即出现在聊天气泡，不用等 createChatMessages 或 AI 回复。
      // 显示文本剥离 eventp/隐藏标签；若剥空则给 ◇ 占位。
      try {
        const show = Router._stripEventp(Router._stripHiddenTags(combined));
        Router.appendChat('user', _userName || '你', (show && show.trim()) ? show.trim() : '◇', null);
        try { Router.renderLastUserBubble(show); } catch (e3) {}
      } catch (e) {}
      try {
        if (win.createChatMessages) {
          await win.createChatMessages([{ role: 'user', name: getUserName(), message: combined }]);
        } else if (win.triggerSlash) {
          await win.triggerSlash(`/send ${combined}`).catch(() => {});
        }
        if (doTrigger && win.triggerSlash) {
          setTimeout(() => win.triggerSlash('/trigger').catch(() => {}), 30);
        }
      } catch (e) { console.warn('[集成战略] _sendAsUser 失败：', e.message); }
    },
  };
});
