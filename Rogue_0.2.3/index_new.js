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

  // 酒馆 advice 机制写入用户消息的固定占位句（"按 advice 继续"的交互产物，非玩家真实输入）：
  // 游戏渲染用户气泡时与战报一并隐藏；真实输入与选项内容不受影响。
  // 两个变体：现行占位句 + 旧版占位句（"按照advice继续吧。"）。
  const ADVICE_PLACEHOLDER_RE = /就按照advice说的来吧，注意一下advice内容还没实际发生，要从头开始执行advice。|按照advice继续吧。?/g;

  // 节点"离开"简介（保留字，精确匹配）：前端合成的「离开节点」选项卡与本拦截共用。
  // 玩家点击简介为此句的选项时，等效于离开本节点（_pickActionOption 内拦截，不产生选项发送残留）。
  // 离开入口口径（v14 离开按钮改版后）：
  //   · 前端在右侧选项栏**常驻**合成一张「离开节点」卡（desc 即本句；两次点击=展开→确认），
  //     与正文 <action_options> 选项一起出现；战斗类节点在主目标收服前不渲染该卡（_nodeCanLeave 门控）。
  //   · 诡意行商例外：保留顶端「离开节点」按钮，不渲染离开卡。
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
          标本库: z.record(
            z.string().describe('编号_干员名'),
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
          }).prefault(() => ({})),
          _全局资产: z.object({
            普瑞赛斯子宫液化储量: z.coerce.number().prefault(0),
            已解锁长期增益: z.record(z.string(), z.boolean()).prefault(() => ({})),
            首次通关标记: z.boolean().prefault(false),
          }).prefault(() => ({})),

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
            $变奏用尽: z.boolean().prefault(false),       // 变奏已耗尽（你的注入条目触发位）
            $锁定: z.boolean().prefault(false),           // 剧情操作锁定（只留离开/调试）
            $待定: z.boolean().prefault(false),           // 已收束、待离开回裂隙
            $终局分支: z.string().prefault(''),           // 第5层 boss 进节点时冻结的结局分支：'hidden'(进第六层) | 'finish'(直接结算) | ''(未定)
            $隐藏关: z.string().prefault(''),             // 本节点命中的隐藏关 id（''=没命中）；离节点即清空
          }).prefault(() => ({})),
          // $难度：纯前端区（AI 只读参考，不得写入）。档位 0~5，逐级叠加（见 DifficultyRules）；
          // 分队：'后勤分队'=已实现；其它分队占位（仅在选牌界面显示"敬请期待"，不写入变量）。
          $难度: z.object({ 档位: z.coerce.number().catch(1).prefault(1), 分队: z.string().catch('后勤分队').prefault('后勤分队') }).catch({}).prefault(() => ({})),
          $开局基线: z.object({
            核心生命: z.coerce.number().catch(0).prefault(0),
            淫堕源石: z.coerce.number().catch(0).prefault(0),
            精液: z.coerce.number().catch(0).prefault(0),
          }).catch({}).prefault(() => ({})),
          $地图状态: z.object({
            层数: z.coerce.number().prefault(1),
            每列: z.array(z.array(z.object({ type: z.string(), id: z.string() }))).prefault(() => []),
            解锁列数: z.coerce.number().prefault(1),
            当前列: z.coerce.number().prefault(0),
          }).prefault(() => ({})),
          $衰减档: z.coerce.number().prefault(0.8),   // 每通关一层 三维污染 × 衰减档（默认每层削减 20%，纯前端）
          $收藏品获得层: z.record(z.string().describe('收藏品名'), z.coerce.number().describe('获得层数')).prefault(() => ({})), // 长期型收藏品获得层数（逐层削减重放用，纯前端登记）
          // $隐藏关（纯前端区）：三类隐藏世界线是否已经"到手"。
          //   f = 随机渠道开放、AI 不知情（只由进节点战报交代"此刻怎么写"）；
          //   t = 对应收藏品已到账 → 该族渠道关闭，并由用户自建 EJS 条目接管"长期怎么写"。
          //   EJS 读法：getvar('stat_data.$隐藏关.海嗣', { defaults: false })
          $隐藏关: z.object({
            海嗣: z.boolean().prefault(false),
            月光: z.boolean().prefault(false),
            特殊源石: z.boolean().prefault(false),
          }).prefault(() => ({ 海嗣: false, 月光: false, 特殊源石: false })),

          // ═══ 叙事/长线（无前缀，AI 可读写）═══
          时间线记忆库: z.record(z.string(), z.string()).prefault(() => ({})),
          剧情日志: z.object({
            近期发展: z.string().prefault('游戏刚开始，一切还是未知。'),
            特殊情趣记录: z.string().prefault('暂无，等待主人的开发。'),
          }).prefault(() => ({})),
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
    pendingDifficulty: null, // 主界面难度按钮选中的档位（未开始游戏前不入变量，null=跟随存档/默认）
    pendingSquad: null,      // 分队选牌界面选中的分队 KEY（同上）
    // 新手建档标记：<确认并出发> 置真，进第一个节点时消费（标本库为空 → 战报附建档指令）。
    // 只存会话内内存（重开窗口不丢，重开脚本即清，正好配合"每局出发重新置真"）。
    firstNodePending: false,
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
  //   ⚠ 全部效果都是"可撤销的额外修正"，不是永久修改：
  //      开局时快照 `_探索进程.$开局基线`，所有加减只记在 `_探索进程.$开局修正`；
  //      换难度/换分队时先按旧修正**精确回退**到基线，再叠加新修正 —— 因此来回切换不会累积，
  //      选回难度 0 / 换掉后勤分队也能完整恢复初始效果。
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
    { key: '指挥分队',  名: '指挥分队',   enabled: false, 图标: 'diamond',  标语: '目标生命上限 +2', 描述: '目标生命上限 +2，每次战斗后额外回复 1 点目标生命' },
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
      win.document.documentElement.style.setProperty('--vh', (Number(win.innerHeight || 0) / 100) + 'px');
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
    };
    reflow();
    if (win.addEventListener) {
      win.addEventListener('resize', reflow);
      win.addEventListener('orientationchange', reflow);
    }
    try { win.document.addEventListener('fullscreenchange', reflow); } catch (e) {}
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
    // 阿米娅·炉芯终曲：外站虽有 char_002_amiya，但立绘要被炉芯终曲的同人稿替掉 →
    //  走自备素材固定不换（用户仓库主分支 main）。
    //  胸像 Avg_avg_npc_6666_1-1$1 (1)(1).png ／ 头像 Avg_avg_npc_6666_1-1$1.png
    "阿米娅_炉芯终曲": { q: Q_URL+'Avg_avg_npc_6666_1-1$1 (1)(1).png', a: Q_URL+'Avg_avg_npc_6666_1-1$1.png', bg: '', id: '', full: false },
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
    "苇草": { q: '', a: '', bg: '', id: 'char_261_sddrag', full: true },
    "W": { q: '', a: '', bg: '', id: 'char_113_cqbw', full: true },
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
    "霜星_寒灾": { q: Q_URL+'edited_image__5_-removebg-preview.png', a: getAva('','Avg_char_1505_frstar_1.png'), bg: '', id: '', full: false },
    "斯卡蒂": { q: '', a: '', bg: '', id: 'char_263_skadi', full: true },
    "浊心斯卡蒂": { q: '', a: '', bg: '', id: 'char_1012_skadi2', full: true },
    "温蒂": { q: '', a: '', bg: '', id: 'char_400_weedy', full: true },
    "羽毛笔": { q: '', a: '', bg: '', id: 'char_421_crow', full: true },
    "多萝西": { q: '', a: '', bg: '', id: 'char_4048_doroth', full: true },
    "白面鸮": { q: '', a: '', bg: '', id: 'char_128_plosis', full: true },
    "泥岩": { q: '', a: '', bg: '', id: 'char_311_mudrok_2', full: true },
    "蕾缪安": { q: '', a: '', bg: '', id: 'char_4193_lemuen', full: true },
    "能天使": { q: '', a: '', bg: '', id: 'char_1041_angel2', full: true },
    "莫斯提马": { q: '', a: '', bg: '', id: 'char_213_mostma', full: true },
    "Mon3tr": { q: '', a: '', bg: '', id: 'char_4179_monstr', full: true },
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
    "林": { q: '', a: '', bg: '', id: 'char_4080_lin', full: true },
    "特蕾西娅": { q: '', a: '', bg: '', id: 'char_4134_cetsyr', full: true },
    // 黑冠特蕾西娅：头像走外站 npc_1296（avatar/npc_1296_tersia.png，外站无其 portrait）；
    //  胸像走自备 Avg_avg_npc_1296_1-1$1.png（主分支）。两者固定，不随晋升切换。
    //  注：干员时代的「特蕾西娅/魔王」仍用 char_4134_cetsyr，与本条不同。
    "黑冠特蕾西娅": { q: Q_URL+'Avg_avg_npc_1296_1-1$1.png', avaId: 'npc_1296_tersia', bg: '', id: '', full: false },
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
    "焰影苇草": { q: '', a: '', bg: '', id: 'char_1020_reed2', full: true },
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
  // 池里的名字是「终曲阿米娅」（见 PoolDB.hiddenBoss），立绘键是「阿米娅_炉芯终曲」——
  // 两条指向同一份图链：否则她被收编进队伍后，卡片/头像会落到 default（普通阿米娅）身上。
  OperatorDB['终曲阿米娅'] = OperatorDB['阿米娅_炉芯终曲'];

  // ── 别称统一表：别称 → OperatorDB 标准键 ──────────────────────────────────
  //   玩家/AI/旧档可能写这些别称（阿尔图罗＝塑心的旧称呼、新约能天使＝能天使异格、
  //   焰影苇草＝苇草异格、寒灾霜星＝霜星_寒灾、林雨霞＝林的完整名、魔王＝特蕾西娅头衔）。
  //   全部登记为同一份图链的同键引用，getOp 即可命中 —— 否则头像/立绘会落回
  //   default（普通阿米娅）造成错位（玩家反馈"阿尔图罗头像失败"即此根因）。
  const OP_ALIAS = {
    '阿尔图罗': '塑心',
    '新约能天使': '能天使',
    '寒灾霜星': '霜星_寒灾',
    '魔王': '特蕾西娅',
  };
  Object.keys(OP_ALIAS).forEach((a) => { OperatorDB[a] = OperatorDB[OP_ALIAS[a]]; });

  // ---- 肉鸽立绘图链（立绘同台用；自动生成自 tools/肉鸽立绘_上传.js --upload，勿手改）----
  //   键: <纯干员名> → <年龄档 -1|0|1> → <阶段 a|b|c>，值为 cb.wss.moe 加速链接。
  //   年龄档: -1=10~15岁, 0=16~28岁, 1=29+；阶段: a=敌方库, b=侵蚀, c=活化。
  //   缺失档位由 _portraitUrlFor 回退（-1/1 → 0，b/c → a；整角无图 → 不显示）。
  const ROUGE_PORTRAIT_CHART = {
    "白金": { "0": { "a": "https://cb.wss.moe/whdruq.webp", "b": "https://cb.wss.moe/pyow0w.webp", "c": "https://cb.wss.moe/h83hbk.webp" } },
    "白面鸮": { "0": { "a": "https://cb.wss.moe/s89762.webp", "b": "https://cb.wss.moe/4sjyz5.webp", "c": "https://cb.wss.moe/tp1frs.webp" }, "1": { "a": "https://cb.wss.moe/mn4tsa.webp", "b": "https://cb.wss.moe/jhg9y7.webp", "c": "https://cb.wss.moe/dnky63.webp" } },
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
    "薇薇安娜": { "0": { "a": "https://cb.wss.moe/6cx4zo.webp", "b": "https://cb.wss.moe/fi3t7o.webp", "c": "https://cb.wss.moe/j8ktcm.webp" } },
    "温蒂": { "0": { "a": "https://cb.wss.moe/e3che8.webp", "b": "https://cb.wss.moe/rmoncu.webp", "c": "https://cb.wss.moe/lvj5su.webp" } },
    "巫恋": { "0": { "a": "https://cb.wss.moe/iku4sk.webp", "b": "https://cb.wss.moe/uzy3rc.webp", "c": "https://cb.wss.moe/d3p8j9.webp" }, "1": { "a": "https://cb.wss.moe/x9b0uu.webp", "b": "https://cb.wss.moe/vtekn4.webp", "c": "https://cb.wss.moe/igng6g.webp" } },
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
    // ── 肉鸽立绘2 补充包（12 角色 · 36 张，接在现有池后；与 src/jczl/肉鸽立绘图链.js 同步，勿手改）──
    "艾雅法拉": { "0": { "a": "https://cb.wss.moe/5jogit.webp", "b": "https://cb.wss.moe/89w0j8.webp", "c": "https://cb.wss.moe/lcewjk.webp" } },
    "安洁莉娜": { "0": { "a": "https://cb.wss.moe/dy8pmg.webp", "b": "https://cb.wss.moe/bjwc58.webp", "c": "https://cb.wss.moe/iz96eb.webp" } },
    "德克萨斯": { "0": { "a": "https://cb.wss.moe/wb83i2.webp", "b": "https://cb.wss.moe/cjg566.webp", "c": "https://cb.wss.moe/gxj7yp.webp" } },
    "多萝西": { "0": { "a": "https://cb.wss.moe/a3uoa0.webp", "b": "https://cb.wss.moe/1vmtxj.webp", "c": "https://cb.wss.moe/62qutk.webp" } },
    "洁尔佩塔": { "0": { "a": "https://cb.wss.moe/ryfyl6.webp", "b": "https://cb.wss.moe/4kfox8.webp", "c": "https://cb.wss.moe/7x00ox.webp" } },
    "凯尔希": { "0": { "a": "https://cb.wss.moe/n777j7.webp", "b": "https://cb.wss.moe/p6p5y5.webp", "c": "https://cb.wss.moe/uk74c6.webp" } },
    "克莱门莎": { "0": { "a": "https://cb.wss.moe/th32rp.webp", "b": "https://cb.wss.moe/iudxpl.webp", "c": "https://cb.wss.moe/5cylsk.webp" } },
    "莫斯提马": { "0": { "a": "https://cb.wss.moe/bje4rt.webp", "b": "https://cb.wss.moe/zt4l03.webp", "c": "https://cb.wss.moe/s4s8du.webp" } },
    "森蚺": { "0": { "a": "https://cb.wss.moe/poj322.webp", "b": "https://cb.wss.moe/ezy361.webp", "c": "https://cb.wss.moe/au7i99.webp" } },
    "提丰": { "0": { "a": "https://cb.wss.moe/w6z6cf.webp", "b": "https://cb.wss.moe/rcqagq.webp", "c": "https://cb.wss.moe/5tqemy.webp" } },
    "天火": { "0": { "a": "https://cb.wss.moe/5rtac4.webp", "b": "https://cb.wss.moe/yr20pl.webp", "c": "https://cb.wss.moe/4taj49.webp" } },
    "伊内丝": { "0": { "a": "https://cb.wss.moe/g0ura1.webp", "b": "https://cb.wss.moe/zw00gg.webp", "c": "https://cb.wss.moe/11cf4f.webp" } }
  };
  // 大号立绘名单（目前唯一：薇薇安娜，鹿角顶到顶边栏）；其余默认小号（高度略低16%）。以后按需增删。
  const PORTRAIT_LARGE = new Set(['薇薇安娜']);

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

  // 从可能的 "干员名_两位编号" 后缀键中提取纯干员名（用于查 OperatorDB / 头像等数值层）。
  // 标本干员键如 "霜星_ab" 只用于唯一标识"她"，前台显示与数值计算回退到纯干员名。
  function cleanName(key) {
    return String(key || '').replace(/_[0-9a-z]{2}$/, '');
  }

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

  /** 定位角色的档案记录（决定 a/b/c 与年龄档）：精确键优先，纯名（cleanName）兜底。 */
  function _findPortraitRecord(vars, nameKey) {
    const base = cleanName(nameKey);
    const look = [
      ['敌方库', nameKey], ['干员编队', nameKey], ['标本库', nameKey],
      ['敌方库', base], ['干员编队', base], ['标本库', base],
    ];
    for (let i = 0; i < look.length; i++) {
      const bag = look[i][0], k = look[i][1];
      const rec = (vars && vars[bag] && vars[bag][k]) || null;
      if (rec && typeof rec === 'object') return { 库: bag, 记录: rec };
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
  /** 名字 → 图源基底名：先最长前缀匹配已知角色名，退而 cleanName 剥两位编号后缀。 */
  function _matchBaseName(name) {
    return _matchKnownName(name) || cleanName(name);
  }

  /** 核心解析：说话人名 → 最终立绘 URL（找不到返回 ''，调用方据此不入台）。 */
  function _portraitUrlFor(nameKey, vars) {
    const base = _matchBaseName(nameKey);   // 最长匹配：兼容 _大老婆 中文后缀
    const slot = (ROUGE_PORTRAIT_CHART || {})[base];
    if (!slot) return '';
    const rec = _findPortraitRecord(vars, nameKey);
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
        const url = _portraitUrlFor(nameKey, readVars(win));
        if (!url) { this.litKey = ''; this.render(); return; }   // 没图 → 不入台（需求6）+ 全暗
        const entry = { key: nameKey, url, large: PORTRAIT_LARGE.has(_matchBaseName(nameKey)) };
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
          if (img) {
            img.src = entry.url;
            // 图片加载完成后：把 img 元素盒精确缩到"实际渲染内容盒"（object-fit:contain 的等效结果）。
            // 效果：① 保持大图（仍由槽位盒 40%×84% 决定，不缩图）；② 内容在槽内水平居中（不偏）；
            //       ③ mask 渐淡只沿内容边缘、四周可见；④ 滤镜变暗只压有颜色像素。
            // ⚠ objectFit 必须用 contain/fill——用 none 会按原始像素绘制并被元素盒裁切（"原像素裁剪"坑）。
            const fit = () => {
              try {
                const box = slotEl.getBoundingClientRect();
                if (!box || !box.width || !box.height || !img.naturalWidth || !img.naturalHeight) return;
                const r = img.naturalWidth / img.naturalHeight;
                let w = box.height * r, h = box.height;
                if (w > box.width) { w = box.width; h = w / r; }
                img.style.width = Math.round(w) + 'px';
                img.style.height = Math.round(h) + 'px';
                img.style.objectFit = 'contain';
              } catch (e) { /* 测量失败保持 CSS 兜底 */ }
            };
            if (img.complete && img.naturalWidth > 0) fit();   // 缓存图 load 可能已派发完
            else img.onload = fit;
          }
        }
      }
      slotEl.classList.toggle('on', !!entry);
      slotEl.classList.toggle('dim', !!entry && !lit);
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
    '特蕾西娅': { 简述: '与普瑞赛斯渊源极深的魔女。', 口癖: '「从今往后，你就是我的全部。」' },
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
        { name: '焰影苇草', quant: 7, folly: 1, axes: [60, 25, 70], rev: [40, 75, 30] },
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
        { name: '焰影苇草', quant: 7, folly: 1, axes: [60, 25, 70], rev: [40, 75, 30] },
        { name: '忍冬', quant: 7, folly: 2, axes: [75, 20, 65], rev: [25, 80, 35] },
        { name: 'Mon3tr', quant: 7, folly: 4, axes: [85, 35, 60], rev: [15, 65, 40], 性别: '女' },
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
        { name: '焰影苇草', quant: 7, folly: 1, axes: [60, 25, 70], rev: [40, 75, 30] },
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
        { name: '余', quant: 9, folly: 2, axes: [50, 30, 80], rev: [50, 70, 20], 性别: '男' },
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
  //   早死角色按史实封顶（霜星 1097）；「魔王」=特蕾西娅死后形态（898~1093 为生时，1094~1108 为魔王）。
  //   别名（ERA_ALIAS）只做解析、不占正式键；正式名 = 池内名（新约能天使 / 林雨霞 / 魔王 …）。
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
    '焰影苇草': [[1088, 1108]], '忍冬': [[1088, 1108]], '鸿雪': [[1090, 1108]],
    '薇薇安娜': [[1092, 1108]], '洁尔佩塔': [[1333, 1333]], '缪尔赛思': [[1085, 1108]],
    'Mon3tr': [[1101, 1108]], '卡莱莎': [[898, 1093], [1094, 1108]],
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
    // 非现役安全键：霜星本人按史实早死封顶（隐藏层用 if 线独立键 寒灾霜星）
    '霜星': [[1084, 1097]],
  };
  /** 年代解析别名（AI/旧写法 → 正式键） */
  const ERA_ALIAS = {
    '林': '林雨霞',
    '特蕾西娅': '魔王',
    '阿米娅_炉芯终曲': '终曲阿米娅',
    '炉芯终曲阿米娅': '终曲阿米娅',
    '普瑞赛斯(星黯未来)': '普瑞赛斯',
    '希尔达(源石圣女)': '希尔达',
  };
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
    // 候选：池内未被携带的干员 → 再滤掉 jczl_custom 禁用的名字（开关筛网；下限保底保证一般非空）
    let candidates = allNames.filter((n) => !carried.has(n) && isNameEnabled(win, n));
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
    const arr = [...set].filter((nm) => isNameEnabled(window, nm)); // 开关筛网：滤掉 jczl_custom 禁用的名字（下限保底，不会空）
    // 洗牌取前 n
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
  }


  // =========================================================================================
  // 【模块2.7：干员开关筛网 jczl_custom】（女性向适配入口）
  //   存储：**聊天变量**（{type:'chat'} 顶层键 jczl_custom = { 干员名: boolean }，扁平名表）。
  //     · 一个聊天文件一份，不随楼层复制、不随 _resetRun 复位 —— 长期且每聊天互相独立。
  //     · **永不自动初始化**：只有玩家在开局界面按「刷新」才写入；缺省（无表）＝全员启用＝原行为。
  //   语义：false 的名字不参与任何 PoolDB 随机抽取（节点遭遇 / boss / 闲暇娱乐 / 开局随机出身）。
  //   来源：名单 100% 派生自 PoolDB（层 1~5 的 作战∪非作战∪boss，**不含 hiddenBoss**），PoolDB 永不被改动。
  //   硬性下限（作者拍板）：每个 作战/非作战 池 ≥5 人，每个 boss 池 ≥2 人；隐藏池不可改（不写入）。
  //     · 单独禁用某人：任一含她的池会跌破下限 → **拒绝写入**（逐池精准校验）；
  //     · 一键批量（全关/只留女/只留男）：先应用后逐池补足（clamp），并回报恢复名单。
  //   性别（作者拍板：PoolDB 条目加可选 `性别` 字段）：缺省 '女'；'男' / '非人' 显式标注。
  //   不受筛影响：固定 boss（收藏品驱动）、隐藏层 boss（hiddenBoss）、标本库手动/随机挑选、AI 自建敌方卡。
  // =========================================================================================
  const FLOOR = { 作战: 5, 非作战: 5, boss: 2 };
  const CUSTOM_KEY = 'jczl_custom';
  const CUSTOM_POOL_TYPES = ['作战', '非作战', 'boss'];
  const CUSTOM_LAYERS = ['1', '2', '3', '4', '5'];

  /** 层 1~5 全部池子的去重名单（不含 hiddenBoss）。 */
  let CUSTOM_NAMES = [];

  /** 派生表全量重建：内置表定义完成时调用一次；【创意工坊】自定义池合入后再调一次。
   *  保证 POOL_BY_NAME / NodePools / 干员开关名单 CUSTOM_NAMES 全部读取合并后的池，
   *  不残留旧快照（本地优先、幂等，重复执行不会叠加）。 */
  function rebuildAllDerived() {
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
    // hiddenBoss 是布尔开关（面板专用）：勾选 → 进入隐藏层 boss 随机池
    if (pools.hiddenBoss === true) poolEntries.push({ layer: 'hiddenBoss', type: 'boss' });
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

  /** chars 列表 → { operatorDB, poolDB, personEra }（同名只取第一条，别名同键）。 */
  function charsToCustomTables(chars) {
    const operatorDB = {}, poolDB = {}, personEra = {};
    const seen = new Set();
    (Array.isArray(chars) ? chars : []).forEach((ch) => {
      if (!ch || ch.启用 === false) return;   // 未启用 → 不入池
      const t = charToPoolEntry(ch);
      if (!t || seen.has(t.name)) return;     // 非法 / 同名 → 跳过（列表靠前优先）
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
    return { operatorDB, poolDB, personEra };
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
    if (pd) {
      Object.keys(pd).forEach((layerKey) => {
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

  /** 读聊天变量 jczl_custom（无表/异常 → {}，视作全员启用）。 */
  function readJczlCustom(win) {
    try {
      const w = win || window;
      const v = w.getVariables && w.getVariables({ type: 'chat' });
      const c = v && v[CUSTOM_KEY];
      return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
    } catch (e) { return {}; }
  }

  /** 写聊天变量 jczl_custom：fn 收到当前表（浅拷贝），返回改后表。 */
  function writeJczlCustom(win, fn) {
    const w = win || window;
    if (!w.updateVariablesWith) return;
    w.updateVariablesWith((vars) => {
      const cur = (vars && vars[CUSTOM_KEY] && typeof vars[CUSTOM_KEY] === 'object' && !Array.isArray(vars[CUSTOM_KEY])) ? vars[CUSTOM_KEY] : {};
      vars[CUSTOM_KEY] = fn({ ...cur });
      return vars;
    }, { type: 'chat' });
  }

  /** 名字是否参与随机：jczl_custom 里显式 false 才禁用；不在表内（未刷新/新增名）＝启用。 */
  function isNameEnabled(win, name) {
    const c = readJczlCustom(win);
    const key = cleanName(String(name == null ? '' : name));
    if (!key) return true;
    if (Object.prototype.hasOwnProperty.call(c, key)) return c[key] !== false;
    return true;
  }

  /** 滤掉禁用的名字。 */
  function filterNames(win, names) {
    return (names || []).filter((n) => isNameEnabled(win, n));
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
  function wouldViolatePool(win, name, enabled) {
    if (enabled) return { violates: false, msg: '' };
    const c = readJczlCustom(win);
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
  function clampCustom(win, custom) {
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
   * 从 PoolDB 重新生成 jczl_custom（唯一写入口之一＝玩家按「刷新」）。
   *  · 首写：全部 true；再刷：保留既有开关，新增名补 true、消失名删除（自改 PoolDB 后刷新不重置选择）。
   *  · hiddenBoss 永不写入。返回生成的名单人数。
   */
  function refreshCustom(win) {
    const old = readJczlCustom(win);
    const next = {};
    CUSTOM_NAMES.forEach((nm) => {
      next[nm] = Object.prototype.hasOwnProperty.call(old, nm) ? old[nm] : true;
    });
    writeJczlCustom(win, () => next);
    return { count: CUSTOM_NAMES.length, custom: next };
  }

  /** 一键批量动作：enabledOf(名字)→是否启用；应用后 clamp 补足下限。返回最终表与恢复名单。 */
  function applyBatch(win, enabledOf) {
    const c = readJczlCustom(win);
    CUSTOM_NAMES.forEach((nm) => { c[nm] = enabledOf(nm); });
    const r = clampCustom(win, c);
    writeJczlCustom(win, () => r.custom);
    return { restored: r.restored, custom: r.custom };
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
   *  · 未命中时 boss 走各层原随机池：例如「克莱门莎」未被固定时仍留在 PoolDB[3].boss 里随机出现。 */
  const FIXED_BOSS_RULES = [
    { 收藏品: '大群交触手', 3: '克莱门莎', 5: '浊心斯卡蒂' },
    { 收藏品: '白月光', 3: '寒灾霜星', 5: '黑冠特蕾西娅' },
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

  // ---- 蚀刻章授予表（长线，跨局保留）------------------------------------------------------
  //  结构见 Schema：蚀刻章[名] = { 描述, 标签 }——"简介"就是 描述（收藏品库页会一起渲染）。
  //  两条都是**第一次**语义：已有此章则整条跳过（幂等），重复调用无害。
  //    · 内部爱            ← 第一次遭遇「洁尔佩塔」；
  //    · 灭世圣女-救世魔王  ← 第一次把「阿米娅·炉芯终曲」编入队伍（也是隐藏层「特殊源石」的前置之一）。
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
      来源: '第一次把 阿米娅·炉芯终曲 编入队伍',
    },
  ];
  /** 编队键的容错匹配词（数组，命中任意一个即可）：
   *   · 池里的名字是「终曲阿米娅」（见 PoolDB.hiddenBoss），立绘键是「阿米娅_炉芯终曲」，
   *     玩家/AI 也可能写成「炉芯终曲阿米娅」—— 三种写法都要能认出来。 */
  const ETCH_ROSTER_KEYWORD = { '灭世圣女-救世魔王': ['炉芯终曲', '终曲阿米娅'] };
  /** 遭遇名匹配词（数组）：节点遭遇口径取 _mainTargetName + 切片字段，按"含该词"判定 */
  const ETCH_ENCOUNTER_KEYWORD = { 内部爱: ['洁尔佩塔'] };

  /** 变量名归一：AI/玩家写入时可能带「」引号或空格，连字符也可能写成全角。 */
  function normName(s) {
    return String(s == null ? '' : s).replace(/[\s「」『』"'’“”]/g, '').replace(/[－—–_]/g, '-').toLowerCase();
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
  //        随机渠道关闭 + 由用户自建的 EJS 条目接管"长期该怎么写"。
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
      此刻: '【待你手写·海嗣】这是一个海嗣灭世的世界线 —— 在此填写"此刻该怎么写"的自然语言指令。',
    },
    {
      id: '月光', 家族: '非特殊', 概率: 0.24, 优先级: 1,
      前置蚀刻章: '', 前置收藏品: '',
      收藏品: { 名: '白月光', 描述: '一团白花状的源石, ta们不再是悲剧, 但另外的ta们只会是悲剧', 值: -50, 标签: '过往' },
      此刻: '【待你手写·月光】这是一个"白月光"的世界线 —— 在此填写"此刻该怎么写"的自然语言指令。',
    },
    {
      id: '特殊源石', 家族: '特殊', 概率: 0.12, 优先级: 2,
      // 前置：必须持有蚀刻章「灭世圣女-救世魔王」（名称匹配，归一后比较）。
      // 收藏品那一格留给以后（目前该事件本身就是产出 我要吃饭 的那一条，前置收藏品留空）。
      前置蚀刻章: '灭世圣女-救世魔王', 前置收藏品: '',
      收藏品: { 名: '我要吃饭', 描述: '一张桌布, 敲三下可以按心情召唤任何美食. 为什么它会出现在这里?', 值: 0, 标签: '' },   // 无效果：值 0 + 空标签 → 两个算值函数都会跳过
      此刻: '【待你手写·特殊源石】跳闸 —— 在此填写"此刻该怎么写"的自然语言指令。',
    },
  ];
  const HIDDEN_IDS = HIDDEN_EVENTS.map((e) => e.id);   // 供以后扩展/调试用

  // =========================================================================================
  // 【模块2：变量 I/O 层 —— 读写聊天/楼层变量 + 初始化 + 开发模式注入】
  // =========================================================================================
  // —— 背景图（5 张共用；依旧半成品 imgchest 图源）——
  const BgMap = {
    out_of_game: 'https://cdn.imgchest.com/files/e608e3713619.jpg',        // 游戏外
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
    标本库: {},
    收藏品: {},
    蚀刻章: {},
    玩家资源: { 核心生命: 10, 淫堕源石: 0, 精液: 0, 所知: 0, 已晋升干员: [] },
    行动: { 额外探索: false, 原定目标: '' },
    _长期总池: { 污染: { 未来: 0, 过往: 0, 现实: 0 }, 去量化: 0 },
    _探索进程: { $当前状态: 'out_of_game', $当前层数: 0, $当前位置: '未出发', $基底干员: '', $隐藏层: false, 当前时间节点: '未知', 当前互动对象: '' },
    _全局资产: { 普瑞赛斯子宫液化储量: 0, 已解锁长期增益: {}, 首次通关标记: false },
    $切片: { $active: false, $status: 'out_of_game', $nodeData: null, $当前时间点: 1094, $当前敌方: '', $软硬: '硬', $原定角色: '', $收服基线: [], $额外收服完成: false, $变奏用尽: false, $锁定: false, $待定: false, $终局分支: '', $隐藏关: '' },
    $难度: { 档位: 1, 分队: '后勤分队' },
    // 开局基线（纯前端）：本局"未被难度/分队修正过"的经济快照。结束时由 _resetRun 归零重来。
    //   经济模型 = 【通关/失败时重置为初始值】→【开局界面前基线恒为初始值】→【出发时基线 + 一份修正】。
    $开局基线: { 核心生命: 10, 淫堕源石: 0, 精液: 0 },
    // 当前生效的开局修正（纯前端：「额外buff」而非永久修改）——重算时按此精确回退，绝不累积。
    $开局修正: { 核心生命: 0, 淫堕源石: 0, 精液: 0 },
    $地图状态: { 层数: 1, 每列: [], 解锁列数: 1, 当前列: 0 },
    $衰减档: 0.8,
    $收藏品获得层: {},
    $隐藏关: { 海嗣: false, 月光: false, 特殊源石: false },
    时间线记忆库: {},
    剧情日志: { 近期发展: '游戏刚开始，一切还是未知。', 特殊情趣记录: '暂无，等待主人的开发。' },
  };

  // ── MVU 原生可扩展标记（方案A）────────────────────────────────────────
  // MVU beta 的运行时 schema 是由 stat_data 数据派生的（generateSchema），节点 extensible
  // 只认三个来源：旧 schema 继承 / 数据上的 $meta.extensible / $meta.recursiveExtensible /
  // 父链递归。z.record / z.intersection 只影响 zod 校验桥（registerMvuSchema），进不了原生层。
  // 所以要让 敌方库/干员编队/标本库 这类"记录容器"天然可扩展（AI 用 json_patch insert 新角色卡
  // 不报"SCHEMA 违规：不可扩展"），必须在容器数据上一次性带 $meta：generateSchema 烘焙成
  // extensible:true 节点后，靠旧 schema 继承永久保持（此后 $meta 即使被清也不影响）。
  // 标记只在 writeVars 写回出口注入，读视图（readVars）统一剥掉，前端业务逻辑看不到。
  const CONTAINERS_WITH_META = ['干员编队', '敌方库', '标本库', '收藏品', '蚀刻章', '时间线记忆库'];
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
    .ps-slot { position: absolute; bottom: 0; width: 40%; height: 84%;   /* 小号：与大号同高基准，顶部略低16% */
      opacity: 0; transition: opacity .35s ease, filter .35s ease; pointer-events: none; }
    .ps-slot.large { height: 100%; }                                     /* 大号：顶到顶边栏 */
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
      animation: titleSplash 3.2s ease forwards; }
    @keyframes titleSplash {
      0% { opacity: 0; transform: translate(-50%, -50%) scale(.96); }
      12% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      78% { opacity: 1; }
      100% { opacity: 0; transform: translate(-50%, -50%) scale(1.02); }
    }
    /* 「出门探索」+ 难度数字按钮 并排（在右下角操作列里：探索键占满剩余宽，难度键固定方块） */
    .home-go-row { position: relative; display: flex; align-items: center; gap: 8px; }
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

    /* ================= 干员开关面板（jczl_custom · 女性向适配入口） ================= */
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
    .custom-switch { position: relative; width: 44px; height: 24px; flex: 0 0 auto; cursor: pointer; }
    .custom-switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 2; }
    .cs-slider { position: absolute; inset: 0; border-radius: 12px; background: rgba(60,66,78,0.9); border: 1px solid rgba(140,160,200,0.3); transition: 0.18s; }
    .cs-slider::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
      background: #cfd8e3; transition: 0.18s; }
    .custom-switch input:checked + .cs-slider { background: rgba(120,170,120,0.55); border-color: rgba(140,220,160,0.6); }
    .custom-switch input:checked + .cs-slider::after { left: 22px; background: #d8fff0; }
    .custom-empty { grid-column: 1 / -1; text-align: center; color: #8b95a6; padding: 30px 0; }

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
  `;

  const Router = {
    init(win) {
      this.win = win;
      this.body = win.document.body;
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
              <button class="top-drop" id="drop-base" title="设置基底">设基底</button>
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
              <select id="target-selector" title="发送对象"><option value="">(无指定对象)</option></select>
              <input id="chat-input" type="text" placeholder="输入对话…" autocomplete="off">
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
      if (db) db.onclick = () => this._openBasePicker();
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

    /** 本局是否已应用过开局设置（难度/分队）。未应用 → 下次「确认并出发」会重新快照基线。 */
    _runApplied() {
      try { return !!(readVars(this.win)['_探索进程'] || {}).$开局已应用; } catch (e) { return false; }
    },

    /**
     * 经济复位为初始值（唯一权威口径）——通关 / 失败 / 熔断三条结束路径共用：
     *   玩家资源 回初始值、开局基线归零、开局修正清零、难度/分队暂时归位默认、$开局已应用 = false。
     * 之后回到开局界面重选编队，再「确认并出发」叠加一份难度/分队修正 →【重置 → 叠加】循环。
     * @param {object} d writeVars 的楼层变量草稿（就地改写）
     */
    _resetEconomyDraft(d) {
      d['玩家资源'] = { 核心生命: 10, 淫堕源石: 0, 精液: 0, 所知: 0, 已晋升干员: [] };
      d['$开局基线'] = { 核心生命: 10, 淫堕源石: 0, 精液: 0 };
      d['$开局修正'] = { 核心生命: 0, 淫堕源石: 0, 精液: 0 };
      d['$难度'] = { 档位: 1, 分队: '后勤分队' };
      d['$衰减档'] = diffCtx(1).decay;   // 归位默认口径（难度2 起为 0.75，由开局时重写）
      const prog = d['_探索进程'] = (d['_探索进程'] && typeof d['_探索进程'] === 'object') ? d['_探索进程'] : {};
      prog.$开局已应用 = false;
    },

    /**
     * 本局范围的变量整体复位（唯一权威口径）——通关 / 失败 / 熔断 三条结束路径共用，
     * 并且**每次「确认并出发」开新局前也会防御性调用**：杜绝任何"上一局的残留状态"
     * （干员编队 / 地图 / 节点切片 / 收藏品 / 行动通道 / 长期池 / 基底干员）泄漏进第二把。
     * 顺序要求：开新局时先复位再写入新的基底干员（见 prep-start）。
     * 长线数据（标本库 / 蚀刻章 / 时间线记忆库 / _全局资产 / 剧情日志）一律保留。
     */
    _resetRunScopedDraft(d) {
      this._resetEconomyDraft(d);
      d['干员编队'] = {};
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
      return PoolDB[L] || PoolDB[5] || {};
    },

    /** 层名（面向玩家/AI 的所有文案都走这里，避免裸拼层号出现"第 100 层"之类） */
    _layerName(layer) {
      const L = Number(layer) || 1;
      return L >= HIDDEN_LAYER ? ('第 ' + L + ' 层（隐藏层）') : ('第 ' + L + ' 层');
    },

    /** 本层 险路恶敌 的固定 boss 名（未命中规则返回 ''）。仅 3/5 层有效。 */
    _fixedBossFor(layer) {
      const L = Number(layer) || 0;
      if (L !== 3 && L !== 5) return '';
      const cds = (readVars(this.win)['收藏品']) || {};
      for (const rule of FIXED_BOSS_RULES) {
        if (hasNamed(cds, rule.收藏品)) return rule[L] || '';
      }
      return '';
    },

    /**
     * 险路恶敌出谁（唯一入口）：
     *   1) 第六层（隐藏层）→ 固定 HIDDEN_BOSS（希尔达）；
     *   2) 第 3/5 层且命中固定 boss 规则 → 固定该干员；
     *   3) 其余 → 该层原随机 boss 池（无 boss 池时退回该层作战池）。
     * 预设数值一律取 POOL_BY_NAME（已合并各层 + hiddenBoss），故固定 boss 不必先进某个池。
     */
    _pickDanger(layer) {
      const L = Number(layer) || 1;
      const pickOne = (l) => (l && l.length) ? l[Math.floor(Math.random() * l.length)] : null;
      if (L >= HIDDEN_LAYER) return POOL_BY_NAME[HIDDEN_BOSS] || pickOne(PoolDB.hiddenBoss);
      const fixed = this._fixedBossFor(L);
      if (fixed && POOL_BY_NAME[fixed]) return POOL_BY_NAME[fixed];
      const pl = PoolDB[L] || {};
      const raw = (pl.boss && pl.boss.length) ? pl.boss : pl.作战;
      // 开关筛网：先滤掉 jczl_custom 禁用的名字（boss 池下限 2 已由拒绝逻辑保底）；滤空才回退原池防死局
      let cands = raw.filter((e) => isNameEnabled(this.win, e && e.name));
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
     * - 从标本库带入的干员（键带 "干员名_编号" 后缀）：以同后缀精确匹配「以新换旧」，覆盖标本库对应条目，避免重复。
     * - 本局内由普通纯名干员晋升进入活化阶段的：为其分配新后缀，作为"新的一位她"新增进标本库（不替换既有历史标本）。
     * 熔断/失败不清标本库（只清局内，见 _failRun/_resetRun）。
     */
    _archiveRunToSpecimen() {
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
        if (names.length) {
          if (!d['标本库']) d['标本库'] = {};
          names.forEach((name) => {
            const data = JSON.parse(JSON.stringify(roster[name]));
            // 两位36进制随机编号（0~1295 → '00'~'zz'）
            const gen = () => Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
            // 带后缀键（来自标本库，密钥为 "干员名_编号"）：以同后缀精确匹配做【以新换旧】，避免重复
            const hasSuffix = /_[0-9a-z]{2}$/.test(name);
            if (hasSuffix) {
              data.身份 = '标本'; data.标本键 = name;   // 标本身份落库（覆盖同键标本条目）
              d['标本库'][name] = data;
              archived++;
              return;
            }
            // 普通纯名活化阶段干员：分配新后缀新增（作为新的一位她）
            let key = `${name}_${gen()}`;
            while (d['标本库'][key]) key = `${name}_${gen()}`; // 防极小概率碰撞
            data.身份 = '标本'; data.标本键 = key;            // 新标本带身份标记
            d['标本库'][key] = data;
            archived++;
          });
        }
      });
      State.currentLayer = 1;
      State.currentNodeData = null;
      State.defeatedEnemies = null;
      State.battleOver = false;
      State.mapCache = null; // 通关归档：清空内存地图缓存，下局重新生成
      State.gameOpened = false;
      if (this.win.alert) this.win.alert(`🎉 通关完成！${archived} 名活化阶段干员已录入永久标本库；其余阶段的干员随之消散。`);
      this.switchView('out_of_game');
    },

    /** 状态机路由：切换主视图 */
    switchView(status) {
      State.currentStatus = status;
      this._closePage();   // 兜底：换视图（进/离节点、回主城、编队）时不许整页浏览器残留盖住新画面
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
      this.body.classList.remove('has-option-rail');
      this.body.classList.toggle('in-map', status === 'map_navigation');
      this.body.classList.toggle('in-chat-left', false);
      this.body.classList.remove('in-node-ui');
      this._syncBaseGateBtn();   // 战斗门同步：作战节点收服前锁定「设基底」，其它视图一律解锁
      if (!main) return;
      this.updateBackground();
      this.refreshStats();
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
        if (lv) lv.onclick = () => { if (State.busyPhase !== 'generating') this._leaveNode(); };
        if (ni.$锁定) {
          const il = this.win.document.getElementById('chat-input');
          const sb = this.win.document.getElementById('chat-send');
          if (il) il.readOnly = true;
          if (sb) sb.disabled = true;
        }
        // 节点内常驻离开卡：进节点即渲染（战斗主目标未收服则不出现；无正文选项时只此一张卡）
        this._ensureLeaveCard();
        return;
      }
      // out_of_game 主城
      this._renderHome();
    },

    /**
     * 初始界面（主城）：开始游戏旁挂一个"难度数字按钮"，点开为全屏上下滑动轮盘。
     * 难度只是前端叠加的效果；真正的应用与写入变量发生在「确认并出发」时（_applyRunDifficulty）。
     */
    _renderHome() {
      const main = this.win.document.getElementById('main-content');
      if (!main) return;
      // 界面加载居中标题：集批的非线性存在（几秒后自动消失；只播一次，不打扰后续）
      this._playTitleSplash();
      const saved = Math.trunc(Number((readVars(this.win)['$难度'] || {}).档位));
      const sel = Number.isFinite(State.pendingDifficulty) ? State.pendingDifficulty : (Number.isFinite(saved) ? Math.max(0, saved) : 1);
      const inert = sel === 0;   // 难度 0：一切不变
      // 主界面保持克制：不放任何旁白/世界观文案，只有出发入口与标本室。
      main.innerHTML = `
        <div class="home-view">
          <div class="home-deco"></div>
          <div class="home-side">
            <button class="big-btn btn-gray" id="home-custom">⚙ 干员开关</button>
            <div class="home-go-row">
              <button class="big-btn btn-gold" id="home-go">🚪 出门探索</button>
              <button class="diff-num-btn${inert ? ' inert' : ''}" id="home-diff" title="选择难度">
                <span class="dnb-cap">难度</span><span class="dnb-num">${this._romanDiff(sel)}</span>
              </button>
            </div>
            <button class="big-btn btn-gray" id="home-collect">🫙 标本室</button>
          </div>
        </div>`;
      const goBtn = this.win.document.getElementById('home-go');
      if (goBtn) goBtn.onclick = () => { State.prepStep = 'squad'; this.switchView('preparation'); };
      const colBtn = this.win.document.getElementById('home-collect');
      // 标本室 = 整页只读浏览窗（与干员编队同一套排版）
      if (colBtn) colBtn.onclick = () => this._renderOpBrowser('标本库');
      const diffBtn = this.win.document.getElementById('home-diff');
      if (diffBtn) diffBtn.onclick = () => this._openDifficultyWheel();
      // 干员开关筛网（女性向适配）：主城直达入口，与 出门探索/标本室 同级大按钮
      const custBtn = this.win.document.getElementById('home-custom');
      if (custBtn) custBtn.onclick = () => this._openCustomPanel();
    },

    /**
     * 主界面加载标题：正中间短暂浮现「集批的非线性存在」，几秒后自动淡出移除。
     * 纯装饰、不占交互，不给界面添任何旁白文案。
     */
    _playTitleSplash() {
      try {
        const doc = this.win.document;
        if (!doc) return;
        const old = doc.getElementById('title-splash');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        const el = doc.createElement('div');
        el.id = 'title-splash';
        el.className = 'title-splash';
        el.textContent = '集批的非线性存在';
        doc.body.appendChild(el);
        // 与 CSS 动画时长(3.2s)对齐后再移除，保证淡出完整且不留残留
        setTimeout(() => {
          try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
        }, 3400);
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
      const specKeys = Object.keys(v['标本库'] || {});
      const firstClear = !!(v._全局资产 && v._全局资产.首次通关标记);
      const canRandom = !firstClear;
      const poolNames = [...new Set([...Object.keys(NodePools.combat || {}), ...Object.keys(NodePools.noncombat || {})])];
      const self = this;
      let chosenKey = '';
      const paint = () => {
        const startBtn = self.win.document.getElementById('prep-start');
        const prev = self.win.document.getElementById('prep-preview');
        if (startBtn) startBtn.disabled = !chosenKey;
        if (prev) {
          if (!chosenKey) { prev.innerHTML = ''; return; }
          prev.innerHTML = `<img src="${opAva(chosenKey)}" style="width:64px;height:64px;object-fit:contain;vertical-align:middle"> <b>${cleanName(chosenKey)}</b>`;
        }
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
          <div class="sec-title">🫙 从标本库挑选</div>
          <div class="op-grid" id="prep-spec" style="margin-top:6px">
            ${specKeys.length ? specKeys.map((k) => `<div class="op-card" data-k="${k}"><img src="${opAva(k)}"><span>${cleanName(k)}</span></div>`).join('') : '<div class="node-ui-empty">标本库空空如也。通关结算时，活化阶段的干员们会自己走进来。</div>'}
          </div>
          <div class="row">
            <button class="big-btn btn-gray" id="prep-back">← 返回</button>
            <button class="big-btn btn-gold" id="prep-start" disabled>确认并出发</button>
          </div>
        </div>`;
      const rnd = this.win.document.getElementById('prep-random');
      if (rnd) rnd.onclick = () => {
        const enabled = filterNames(this.win, poolNames); // 开关筛网：滤掉 jczl_custom 禁用的名字（下限保底，不会空）
        chosenKey = enabled.length ? enabled[Math.floor(Math.random() * enabled.length)] : (poolNames.length ? poolNames[Math.floor(Math.random() * poolNames.length)] : '阿米娅');
        this._syncBaseCard(chosenKey); // 实时把真实数值写入变量
        paint();
      };
      container.querySelectorAll('#prep-spec .op-card').forEach((card) => {
        card.onclick = () => { chosenKey = card.dataset.k; this._syncBaseCard(chosenKey); paint(); };
      });
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
          d['_探索进程'].$开局已应用 = false;   // 点了出发 = 本局从零开始：重新快照基线并应用开局修正
        });
        // 点击开始游戏 → 应用（或按新选择重算）难度/分队修正并写入变量保存（纯前端叠加）
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
        State.firstNodePending = true;  // 新开局：第一个节点战报附"新手建档"指令（标本库为空时）
        this.refreshStats();
        this.switchView('map_navigation');
      };
      paint();
    },

    /**
     * 【干员开关】全屏面板（jczl_custom 扁平名表 · 女性向适配入口）。
     *  · 名单 100% 派生自 PoolDB（层 1~5 的 作战∪非作战∪boss，不含 hiddenBoss）；
     *  · 开关即时写聊天变量；单独禁用受「逐池下限」拒绝保护（作战/非作战 5、boss 2）；
     *  · 一键动作（全关/只留女/只留男）先应用后逐池补足，并回报恢复名单；
     *  · 「刷新」= 从 PoolDB 重新生成名单（保留既有开关，新增名补 true、消失名删除），永不自动初始化。
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

      /** 渲染列表与统计。ov 传入时按该表渲染（写后乐观更新，避免异步落盘前读到旧值）。 */
      const render = (ov) => {
        const c = ov || readJczlCustom(this.win);
        const q = ((doc.getElementById('custom-search') || {}).value || '').trim();
        const rows = CUSTOM_NAMES
          .filter((nm) => !q || nm.indexOf(q) >= 0)
          .map((nm) => {
            const on = c[nm] !== false;
            return '<div class="custom-row' + (on ? '' : ' off') + '">'
              + '<img class="custom-ava" src="' + opAva(nm) + '" alt="">'
              + '<div class="custom-name">' + this._escapeHtml(nm)
              + '<span class="custom-gender">' + this._escapeHtml(genderOf(nm)) + '</span></div>'
              + '<label class="custom-switch"><input type="checkbox" data-n="' + this._escapeHtml(nm) + '"' + (on ? ' checked' : '') + '><span class="cs-slider"></span></label>'
              + '</div>';
          })
          .join('');
        const list = doc.getElementById('custom-list');
        if (list) list.innerHTML = rows || '<div class="custom-empty">没有匹配的干员</div>';
        const onCnt = CUSTOM_NAMES.filter((nm) => c[nm] !== false).length;
        const stat = doc.getElementById('custom-stat');
        if (stat) stat.innerHTML = '已启用 ' + onCnt + ' / ' + CUSTOM_NAMES.length + ' 人（作战/非作战池保底 5 人 · boss 池保底 2 人 · 隐藏池不参与）';
        if (list) list.querySelectorAll('input[type=checkbox]').forEach((cb) => {
          cb.onchange = () => {
            const nm = cb.dataset.n;
            const want = cb.checked;
            const v = wouldViolatePool(this.win, nm, want);
            if (v.violates) { cb.checked = !want; flash(this._escapeHtml(v.msg), true); return; }
            const next = { ...readJczlCustom(this.win), [nm]: want };
            writeJczlCustom(this.win, (d) => { d[nm] = want; return d; });
            render(next);
            flash('已' + (want ? '启用' : '禁用') + '「' + this._escapeHtml(nm) + '」');
          };
        });
      };

      overlay.innerHTML =
        '<div class="custom-head">干员开关'
        + '<span class="custom-hint">禁用的干员不参与随机抽取（节点遭遇 / boss / 闲暇娱乐 / 开局随机出身）· 名单来自 PoolDB，改动 PoolDB 后按「刷新」重新生成</span>'
        + '<input id="custom-search" class="custom-search" placeholder="搜索干员名…">'
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
            const r = refreshCustom(this.win);
            render(r.custom);
            flash('已按 PoolDB 重新生成名单（' + r.count + ' 人，既有开关已保留）');
            return;
          }
          let out;
          if (a === 'all_on') {
            const next = {};
            CUSTOM_NAMES.forEach((nm) => { next[nm] = true; });
            writeJczlCustom(this.win, () => next);
            render(next);
            flash('已全部启用');
            return;
          } else if (a === 'all_off') {
            out = applyBatch(this.win, () => false);
          } else if (a === 'only_f') {
            out = applyBatch(this.win, (nm) => genderOf(nm) === '女');
          } else if (a === 'only_m') {
            out = applyBatch(this.win, (nm) => genderOf(nm) === '男');
          } else { return; }
          render(out.custom);
          flash(out.restored.length
            ? '已执行。为守住下限自动恢复：' + this._escapeHtml(out.restored.slice(0, 8).join('、')) + (out.restored.length > 8 ? ' 等 ' + out.restored.length + ' 人' : '')
            : '已执行。');
        };
      });
      render();
    },

    /** preparation 是"分队选牌 + 编队"两步共用状态；按 State.prepStep 分发渲染 */
    _renderPreparation(main) {
      if (State.prepStep === 'squad') { this.renderSquadSelect(main); return; }
      State.prepStep = 'roster';
      this.renderPrep(main);
    },

    _shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      return arr;
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

      // 两段式选择（仅当前可点列节点可点；互斥）
      const nodes = container.querySelectorAll('.map-node');
      nodes.forEach((nd) => {
        if (nd.classList.contains('locked') || nd.classList.contains('passed')) { nd.style.cursor = 'not-allowed'; return; }
        nd.onclick = () => {
          const isSelected = nd.classList.contains('selected');
          nodes.forEach((x) => x.classList.remove('selected'));
          if (!isSelected) {
            nd.classList.add('selected');
            return;
          }
          this._enterNode(nd.dataset.type, parseInt(nd.dataset.col, 10), parseInt(nd.dataset.idx, 10));
        };
      });
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
      const cols = [];
      for (let i = 0; i < totalCols; i++) {
        // 隐藏层：每列固定 1 节点；普通层末级固定 1 节点、中间级随机 1~3
        const n = hidden ? 1 : (i === lastCol ? 1 : Math.min(3, 1 + Math.floor(Math.random() * 3)));
        const arr = [];
        for (let j = 0; j < n; j++) {
          arr.push({ type: this._randomNodeType(i, layer, totalCols), id: `L${layer}C${i}N${j}` });
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
          State.currentLayer = layerNow + 1;
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
          const spec = v['标本库'] || {};
          const specKeys = Object.keys(spec);
          if (specKeys.length) {
            // 返回完整标本键（如 "霜星_ab"），保留其标本来源身份；无后缀键时回退纯名
            const k = specKeys[Math.floor(Math.random() * specKeys.length)];
            return /_[0-9a-z]{2}$/.test(k) ? k : cleanName(k);
          }
          const nc = NodePools['noncombat'] ? Object.keys(NodePools['noncombat']) : [];
          // 排除已在编队（携带）中的干员（精确匹配纯名，标本键剥后缀比对）
          const carried = new Set(Object.keys((v['干员编队'] || {})).map((n) => cleanName(n)));
          const cands = nc.filter((n) => !carried.has(n) && isNameEnabled(this.win, n));
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
     * 只有收藏品真正落账才转 t，随即关闭该族渠道、由用户自建 EJS 接管长期叙事。
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
        const v = readVars(this.win);
        const bag = (v['$隐藏关'] && typeof v['$隐藏关'] === 'object') ? v['$隐藏关'] : {};
        const winners = [];
        HIDDEN_FAMILIES.forEach((fam) => {
          const pool = HIDDEN_EVENTS.filter((e) => e.家族 === fam);
          if (!pool.length) return;
          if (pool.some((e) => !!bag[e.id])) return;                    // ① 族内任一为 t → 整族关闭
          const cands = pool.filter((e) => this._hiddenPrereqOK(e, v));  // ② 前置条件
          if (!cands.length) return;
          if (Math.random() >= cands[0].概率) return;                    // ③ 整族一次掷骰
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
      for (let L = 1; L <= layer; L++) {
        gainOfLayer(L);
        if (L < layer) { cur.未来 *= decay; cur.过往 *= decay; cur.现实 *= decay; }
      }
      // 去量化：全体干员取最高；仅当【多人并列最高】时才 +1（不再因多人人数 +1；不被层削减）
      // 难度3+：每过一层 战力 −1（只改动长期池数值，不改干员信息）——与每层削轴同口径，过层数 = 层数−1
      const opNames = Object.keys(roster);
      let maxQ = 0, ties = 0;
      opNames.forEach((n) => {
        const q = Number((roster[n] || {}).去量化) || 0;
        if (q > maxQ) { maxQ = q; ties = 1; }
        else if (q === maxQ && q > 0) ties++;
      });
      const layPowPenalty = this._diffCtx().layerPowerPenalty || 0;
      const deq = Math.max(0, maxQ + (ties > 1 ? 1 : 0) - layPowPenalty * Math.max(0, layer - 1));
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
     *  ③ 标本库中存在该键（覆盖旧档/整键复制场景）；④ 键符合旧惯例 "名_两位编号" 后缀（兜底兼容历史数据，
     *  误差方向安全——偏向"不算变奏"，避免误锁节点）。 */
    _unitIsSpecimen(key, rec, vars) {
      const k = String(key || '');
      if (!k) return false;
      if (rec) {
        if (String(rec.身份 || '') === '标本') return true;
        if (typeof rec.标本键 === 'string' && rec.标本键) return true;
      }
      try {
        const spec = (vars && vars['标本库']) || {};
        if (Object.prototype.hasOwnProperty.call(spec, k)) return true;
      } catch (e) {}
      return /_[0-9a-z]{2}$/.test(k);
    },

    /** 变奏审计：进节点后若"干员编队"出现非原定角色的新增（额外收服成功入库）→ 变奏用尽+锁定，稍后自动弹出 */
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
        this._persistNodeSlice({
          active: true, status: 'event_node', nodeData: ni.$nodeData, year: ni.$当前时间点, 敌方: ni.$当前敌方,
          锁定: true, 变奏用尽: true, 额外收服完成: true, 待定: true,
        });
        // 变奏收束通知（M2c）：`$锁定/$变奏用尽` 属 `$` 隐藏区，AI 根本看不见这两个变量，
        // 所以必须在收束时**主动告知**，否则 AI 会继续安排第三次额外收服。
        const second = cleanName(added[0]) || '她';
        setTimeout(() => {
          try { Engine._sendAsUser(this.win, this._sys('已收服主目标之外的' + (second === '她' ? second : ('<' + second + '>')) + '。节点收束，据此离开此间。')); } catch (e) {}
        }, 200);
        const self = this;
        setTimeout(() => {
          try {
            const ni2 = readVars(self.win)['$切片'] || {};
            if (ni2.$active && ni2.$锁定 && State.currentStatus === 'event_node') self._leaveNode();
          } catch (e) {}
        }, 900);
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
     *  与蓝色我方共存对比（战斗节点内用）。 */
    _radarSVGLabeled(pollArr, enemyArr) {
      const names = ['未来', '过往', '现实'];
      const vals = [Number(pollArr && pollArr[0]) || 0, Number(pollArr && pollArr[1]) || 0, Number(pollArr && pollArr[2]) || 0];
      const maxV = Math.max(100, vals[0], vals[1], vals[2]);
      const scaleR = (val) => 46 * val / maxV;
      const px = (i, r) => {
        const a = Math.PI / 2 + i * 2 * Math.PI / 3;
        return (60 + Math.cos(a) * r).toFixed(1) + ',' + (58 - Math.sin(a) * r).toFixed(1);
      };
      const ring = (r) => [0, 1, 2].map((i) => px(i, r)).join(' ');
      const data = [0, 1, 2].map((i) => px(i, scaleR(vals[i]))).join(' ');
      // 敌方红色层（同坐标系，独立缩放上限，避免被 100 上限压缩失真）
      let enemyPoly = '';
      if (enemyArr && enemyArr.length === 3) {
        const evals = [Number(enemyArr[0]) || 0, Number(enemyArr[1]) || 0, Number(enemyArr[2]) || 0];
        const emax = Math.max(100, evals[0], evals[1], evals[2]);
        const escaleR = (val) => 46 * val / emax;
        const edata = [0, 1, 2].map((i) => px(i, escaleR(evals[i]))).join(' ');
        enemyPoly = '<polygon points="' + edata + '" fill="rgba(255,92,92,.13)" stroke="#ff6a6a" stroke-width="1.5"/>';
      }
      // 顶点标注锚点：上=未来、左下=过往、右下=现实（锚点置于外圈之外）
      const pts = [
        { x: 60, y: 6, anchor: 'middle' },
        { x: 10, y: 90, anchor: 'start' },
        { x: 110, y: 90, anchor: 'end' },
      ];
      let labels = '';
      for (let i = 0; i < 3; i++) {
        const p = pts[i];
        labels += `<text x="${p.x}" y="${p.y}" text-anchor="${p.anchor}" font-size="10" fill="#9fe3ff">${names[i]}</text>`
          + `<text x="${p.x}" y="${p.y + 12}" text-anchor="${p.anchor}" font-size="11" font-weight="bold" fill="#ffffff">${this._num(vals[i])}</text>`;
      }
      return '<svg width="120" height="116" viewBox="0 0 120 116">'
        + '<polygon points="' + ring(46) + '" fill="none" stroke="#3a3f4a"/>'
        + '<polygon points="' + ring(23) + '" fill="none" stroke="#2a2e38"/>'
        + enemyPoly
        + '<polygon points="' + data + '" fill="rgba(122,200,255,.2)" stroke="#7ac8ff" stroke-width="1.5"/>'
        + labels
        + '</svg>';
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
     * source='标本库' 时额外显示标本编号后缀（#xx）。
     */
    _opCardHTML(k, op, sel, source) {
      const nm = cleanName(k);
      const art = opArt(k, artEliteOf(op));
      const p = (op && op.污染) || {};
      const promoted = !!(op && op.已晋升);
      const stage = promoted ? '已晋升' : ((op && op.状态) || '—');
      const ribbonCls = promoted ? ' gold' : ((op && op.状态 === '正常') ? ' dim' : '');
      const idx = source === '标本库' ? String(k).slice(nm.length).replace(/^_/, '') : '';
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
     */
    _opDetailHTML(k, source, mode) {
      if (!k) return '<div class="dt-empty">轻触右侧干员卡<br>查看她的数值与档案</div>';
      const nm = cleanName(k);
      const v = readVars(this.win);
      const op = (v[source] || {})[k] || {};
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
        + '<div class="dt-top"><img src="' + opArt(k, (source === '标本库') ? this._specElite : artEliteOf(op)) + '" alt="">'
        + '<span class="dt-id"><span class="dt-name">' + this._esc(nm) + '</span>'
        + '<span class="dt-state">状态 <b>' + this._esc(op.状态 || '?') + '</b>　已晋升 <b>' + (op.已晋升 ? '是' : '否') + '</b></span></span></div>'
        + ((source === '标本库')
          ? '<div class="dt-arts"><button class="dt-art' + (this._specElite ? '' : ' on') + '" data-e="0">精一胸像</button>'
            + '<button class="dt-art' + (this._specElite ? ' on' : '') + '" data-e="1">精二胸像</button>'
            + '<span class="dt-arthint">标本库可临时查阅，默认精一</span></div>'
          : '')
        + '<div class="dt-tabs">'
        + '<div class="dt-tab' + (mode === 'narr' ? '' : ' on') + '" data-m="num">数值 / 三轴</div>'
        + '<div class="dt-tab' + (mode === 'narr' ? ' on' : '') + '" data-m="narr">叙事档案</div></div>'
        + '<div class="dt-body">' + (mode === 'narr' ? narr : num) + '</div></div>';
    },

    /**
     * 干员浏览器：**干员编队 与 标本库 排版共通**（同一套宽卡 + 左栏详情），
     * 差别只有数据来源与是否只读：
     *   · '干员编队' → 带「晋升」入口；
     *   · '标本库'   → 纯浏览，不提供任何改动入口（本次需求：只查看）。
     */
    _renderOpBrowser(source) {
      const isSpec = source === '标本库';
      const v = readVars(this.win);
      const bag = v[source] || {};
      const keys = Object.keys(bag).sort((a, b) => cleanName(a).localeCompare(cleanName(b), 'zh'));
      const sub = keys.length
        ? (isSpec ? ('永久收藏 ' + keys.length + ' 位　只读浏览') : ('在编 ' + keys.length + ' 位'))
        : '';
      const extra = isSpec ? '' : '<button class="mini-btn" id="pg-promote">⬆ 晋升</button>';
      const list = keys.length
        ? '<div class="du-grid">' + keys.map((k) => this._opCardHTML(k, bag[k] || {}, false, source)).join('') + '</div>'
        : '<div class="pg-empty">' + (isSpec
            ? '标本室空空如也。<br>通关结算时，活化阶段的干员们会自己走进来。'
            : '编队为空。<br>出门探索时收服的干员会出现在这里。') + '</div>';
      const pg = this._openPage(
        this._pageHeadHTML(isSpec ? '🫙 标本室' : '▣ 干员编队', sub, extra)
        + '<div class="pg-body">'
        + '<div class="pg-side" id="pg-side">' + this._opDetailHTML('', source, 'num') + '</div>'
        + '<div class="pg-main" id="pg-main">' + list + '</div>'
        + '</div>'
      );
      const side = pg.querySelector('#pg-side');
      let selKey = '';
      let selMode = 'num';
      this._specElite = false;   // 标本库胸像查阅档位：默认精一（临时查阅，不改档案）
      const bindTabs = () => {
        side.querySelectorAll('.dt-tab').forEach((t) => {
          t.onclick = () => { selMode = t.dataset.m === 'narr' ? 'narr' : 'num'; paintSide(); };
        });
        // 标本库专用：精一/精二胸像切换（仅前端查阅，不动变量）
        side.querySelectorAll('.dt-art').forEach((b) => {
          b.onclick = () => { this._specElite = b.dataset.e === '1'; paintSide(); };
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
      if (!isSpec) {
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
        + '<div class="pg-body"><div class="pg-main">' + body + '</div></div>');
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

    /** 干员编队 = 整页浏览器（可晋升）；标本库由 _renderOpBrowser('标本库') 复用同一排版且只读。 */
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
              enemyTxt = '<div style="text-align:center;margin-top:2px;color:#ff8f8f;font-size: max(11px, calc(11px + var(--fs-d, 0px)))">敌方 '
                + this._num(ep.未来) + ' / ' + this._num(ep.过往) + ' / ' + this._num(ep.现实) + '</div>';
            }
          }
        } catch (e) {}
      }
      return '<div class="radar-panel" id="radar-panel"><h4>三轴雷达</h4>'
        + '<div style="text-align:center">' + this._radarSVGLabeled([axes.未来, axes.过往, axes.现实], enemyArr) + '</div>'
        + '<div style="text-align:center;margin-top:2px">去量化 <b style="color:#fff">' + this._num(deq) + '</b> ｜ 所知 <b style="color:#fff">' + this._num(known) + '</b></div>'
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
      if (old) { old.outerHTML = html; return; }
      const tmp = doc.createElement('div');
      tmp.innerHTML = html;
      const node = tmp.firstChild;
      if (node) doc.body.appendChild(node);
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
        return names.filter(Boolean).map((s) => cleanName(String(s))).join('|');
      } catch (e) { return ''; }
    },

    /** 编队里是否存在"名字含任一关键词"的干员（编队键由 AI 写，键名容错匹配） */
    _rosterHasKeyword(keywords) {
      try {
        const list = Array.isArray(keywords) ? keywords : [keywords];
        const r = readVars(this.win)['干员编队'] || {};
        return Object.keys(r).some((k) => list.some((kw) => kw && cleanName(k).includes(kw)));
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
        const v = readVars(this.win);
        const owned = (v['蚀刻章'] && typeof v['蚀刻章'] === 'object') ? v['蚀刻章'] : {};
        const hit = [];
        const blob = this._encounteredNameBlob();
        ETCH_RULES.forEach((rule) => {
          if (hasNamed(owned, rule.name)) return;                       // 已有此章 → 不触发
          const eks = ETCH_ENCOUNTER_KEYWORD[rule.name];
          if (eks && (Array.isArray(eks) ? eks : [eks]).some((kw) => kw && blob.includes(kw))) { hit.push(rule); return; }
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

    /** 「设基底」按钮的战斗门同步（与离开门控共用判定 _nodeCanLeave）：
     *  作战节点收服主目标前锁定（防作战中临时改基底/逃逸）；非作战/已收服/无主目标 → 可用。 */
    _syncBaseGateBtn() {
      try {
        const btn = this.win.document.getElementById('drop-base');
        if (!btn) return;
        const locked = !this._nodeCanLeave();
        btn.disabled = locked;
        btn.classList.toggle('gate-locked', locked);
        btn.title = locked ? '作战节点需先了结此间主目标' : '设置基底';
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
        if (!rail.querySelector('.opt-card[data-leave-card]')) this._appendLeaveCard(rail);
        this.body.classList.add('has-option-rail');
      } catch (e) {}
    },

    /** 设置为三轴基底：写入 $基底干员；该干员尚无数值则用池内预设补上，已有则保留真实值；随后重算长期池 */
    _setBaseOperator(key) {
      if (State.busyPhase === 'generating') return;        // 思考中禁止设基底（会写变量/重算池）
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
      State.entryRoster = null; // 基底变更 → 下一次进节点重新快照
    },

    /** 三轴基底选择界面：列在编干员 → 点选即设为基底 */
    _openBasePicker() {
      if (State.busyPhase === 'generating') return;        // 思考中禁止打开基底选择
      if (!this._nodeCanLeave()) {                          // 战斗门：作战节点收服前锁定（与离开同口径）
        try { if (this.win && this.win.alert) this.win.alert('作战节点需先了结此间主目标'); } catch (e) {}
        return;
      }
      const v = readVars(this.win);
      const roster = v['干员编队'] || {};
      const keys = Object.keys(roster);
      const base = (v._探索进程 && v._探索进程.$基底干员) || '';
      if (!keys.length) { this._uiAlert('编队为空，先收编或选择基底干员。', '设基底'); return; }
      const cards = keys.map((k) => {
        const op = roster[k] || {};
        const p = op.污染 || {};
        const isBase = k === base;
        return '<div class="op-card' + (isBase ? ' promote-pick' : '') + '" data-k="' + k + '">'
          + '<img src="' + opAva(k) + '">'
          + '<span class="nm">' + cleanName(k) + (isBase ? ' ·基底' : '') + '</span>'
          + '<span class="tag">' + this._num(p.未来 || 0) + ' / ' + this._num(p.过往 || 0) + ' / ' + this._num(p.现实 || 0) + '</span>'
          + '</div>';
      }).join('');
      const box = this._openOverlay('<h3>设 基底</h3>'
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
     * 战斗裁定（面向 AI）：情报行（优势轴/削弱门槛/战力差值）+ 按判定**只输出一个分支指令**。
     *  分支：可削弱后胜 / 可削弱仍不胜 / 不削可碾压 / 不可削且战力不足 / 相持。
     *  必败分支统一以「献祭吞噬」收场（扣 核心生命 -N；归零=失败，未归零=收服成功），
     *  并附「仍要给出所有可能的尝试选项」。
     *  无原理解释、无"唯一口径"式元话语；指示语句全部保留。
     */
    _battleVerdictText(b, deqBase, enemy, known) {
      const r2 = (x) => this._round2(x);
      const eqE = Number(enemy && enemy.量化) || 0;
      const fo = Number(enemy && enemy.痴愚) || 0;
      const kn = Number(b.knownDelta) || 0;
      const deq = Number(deqBase) || 0;
      const dLose = r2((deq + kn) - (eqE + fo));          // 直战（不削弱）
      const dWin = r2((deq + kn) - ((eqE / 2) + fo));     // 削弱成功后
      const weakAxes = (b.winAxes && b.winAxes.length) ? b.winAxes.join('/') : '无';
      const need = Number(b.need) || 1;
      // 献祭吞噬系数（按当前节点类型；与"放弃抵抗"结算口径一致）
      const sac = (() => {
        try {
          const nd = ((readVars(this.win)['$切片'] || {}).$nodeData) || {};
          const t = (nd && nd.type) || State.nodeType || '';
          if (t === '险路恶敌') return (Number(State.currentLayer) || 1) >= HIDDEN_LAYER ? 30 : 3;
          if (t === '紧急作战') return 2;
          return 1;   // 作战 / 不期而遇转作战
        } catch (e) { return 1; }
      })();
      const sacTxt = '写 玩家资源.核心生命 -' + sac + '（当前节点系数）；归零=失败，未归零=收服成功；禁止把玩家写成单方面挨打';
      const head = '【战斗裁定】优势轴(敌方弱点): ' + weakAxes + '。削弱需要 ' + need + ' 条优势轴。'
        + '\n战力: 我方去量化 ' + r2(deq) + '(所知 ' + r2(kn) + ') vs 敌方 量化 ' + r2(eqE) + '+痴愚 ' + r2(fo) + ', 直战差 ' + dLose + ', 削弱后差 ' + dWin + '。';
      const trySuffix = '仍要给出所有可能的尝试选项。';
      let judge;
      if (b.advantage && dLose > 0) {
        // 全优：可削弱 + 直战也可胜（三轴/战力全优）。此时 dWin = dLose + 敌量化/2 恒 > 0，削后只会更稳。
        judge = '判定: 三轴与战力全优——可削弱敌方，且即使不削弱直战亦可胜。三轴削弱无绝对必要，任何打法皆可取胜；胜后收服。';
      } else if (b.advantage && dWin > 0) {
        judge = '判定: 可削弱敌方。直战不胜，必须先以三轴削弱敌方（削弱不判胜），再决胜；胜后收服。玩家若不选削弱轴直接硬拼: 必败，以献祭吞噬收场——' + sacTxt + '。' + trySuffix;
      } else if (b.advantage) {
        judge = '判定: 可削弱敌方（需 ' + need + ' 轴），但削弱后仍不可战胜 — 必败。以献祭吞噬收场——' + sacTxt + '。' + trySuffix;
      } else if (dLose > 0) {
        judge = '判定: 即使不削弱也可碾压收服。直接交锋取胜，胜后收服。';
      } else if (dLose === 0) {
        judge = '判定: 相持，掷骰定胜负后按结果推进。';
      } else {
        judge = '判定: 无法削弱（需 ' + need + ' 轴，现 ' + (b.winAxes ? b.winAxes.length : 0) + ' 轴）且我方战力不足以对抗 — 必定失败。以献祭吞噬收场——' + sacTxt + '。' + trySuffix;
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
     * 应用「开局设置」（难度 + 分队）——经济模型（唯一权威口径）：
     *
     *   【重置】通关 / 失败 / 熔断 → `_resetRun()` 把经济**复位为初始值**（10 / 0 / 0 / 0）并把 `$开局基线` 归零；
     *   【加】  开局界面（分队选牌 → 编队）每次「确认并出发」→ 基线快照 = **当前经济**，再把难度/分队修正叠上去。
     *
     *   ⚠ 两条铁律：
     *   1) **只有"确认并出发"才加**：开局前的改难度/改分队不直接改经济，只更新暂存值；
     *      即使反复点出发，也是「还原到基线再重算」→ 幂等，**绝不叠加**。
     *   2) **每次重算都从基线出发，不做增量截断**：`经济 = 基线 + 修正`（下钳 min(0, 基线) 只是防负数，不影响可复现性）。
     *      因此难度/分队之间**互斥**，来回切换不累积；只有难度会"叠加更低级难度的规则"，资源修正始终只有一份。
     */
    _applyRunDifficulty() {
      if (State.busyPhase === 'generating') return;        // 思考中禁止「确认并出发」（会写经济/修正）
      const lv = Number.isFinite(State.pendingDifficulty) ? State.pendingDifficulty : this._effDiff();
      const squad = State.pendingSquad || '后勤分队';
      const { delta, notes, ctx } = this._runDelta(lv, squad);
      let firstApply = false;
      writeVars(this.win, (d) => {
        const diff = d['$难度'] = (d['$难度'] && typeof d['$难度'] === 'object') ? d['$难度'] : {};
        diff.档位 = lv;
        diff.分队 = squad;
        // 难度2：每层三轴削减 20% → 25%（系数，无累积问题）
        d['$衰减档'] = ctx.decay;

        const prog = d['_探索进程'] = (d['_探索进程'] && typeof d['_探索进程'] === 'object') ? d['_探索进程'] : {};
        const res = d['玩家资源'] = (d['玩家资源'] && typeof d['玩家资源'] === 'object') ? d['玩家资源'] : {};
        const prev = (d['$开局修正'] && typeof d['$开局修正'] === 'object') ? d['$开局修正'] : { 核心生命: 0, 淫堕源石: 0, 精液: 0 };
        const base = (prog.$开局基线 && typeof prog.$开局基线 === 'object') ? prog.$开局基线 : null;

        // ① 还原到基线：首次应用 = 快照当前经济；已在本次开局设置流程里 = 用已存基线（幂等重算）
        if (!prog.$开局已应用 || !base) {
          firstApply = true;
          prog.$开局基线 = {
            核心生命: Number(res.核心生命) || 0,
            淫堕源石: Number(res.淫堕源石) || 0,
            精液: Number(res.精液) || 0,
          };
          prog.$开局已应用 = true;
        } else {
          // 重新应用（本局内换难度/换分队）：先把旧修正**精确回退**掉
          res.核心生命 = (Number(res.核心生命) || 0) - (Number(prev.核心生命) || 0);
          res.淫堕源石 = (Number(res.淫堕源石) || 0) - (Number(prev.淫堕源石) || 0);
          res.精液 = (Number(res.精液) || 0) - (Number(prev.精液) || 0);
        }

        // ② 叠加新修正（每次都是"基线 + 这一份修正"，因此切换不累积）
        //    下钳 = min(0, 基线)：基线恒为 0 时禁止负数；万一基线本身为负则允许保持该负值，保证可逆可复现。
        const bp = prog.$开局基线;
        const floorOf = (b) => Math.min(0, Number(b) || 0);
        res.核心生命 = Math.max(floorOf(bp.核心生命), (Number(res.核心生命) || 0) + delta.核心生命);
        res.淫堕源石 = Math.max(floorOf(bp.淫堕源石), (Number(res.淫堕源石) || 0) + delta.淫堕源石);
        res.精液 = Math.max(floorOf(bp.精液), (Number(res.精液) || 0) + delta.精液);
        prog.$开局修正 = { 核心生命: delta.核心生命, 淫堕源石: delta.淫堕源石, 精液: delta.精液 };
      });
      return { 档位: lv, 分队: squad, 备注: notes, ctx, firstApply, delta };
    },

    /** 进节点展示叠加过程：年份 / 生效收藏品 / 最终三轴；作战节点额外给出敌方数值对比 + 优势轴 + 判定 */
    _showNodeStackOverlay() {
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
      const col = colIdx != null ? colIdx : 0;
      const seq = nodeIdx != null ? nodeIdx : 0;
      const nodeId = `L${State.currentLayer}C${col}N${seq}`;
      // 干员池：前端决定"该层该节点类型出现谁"；数值为预设，随报告交 AI 建档。
      // 遭遇规则：安全屋=无目标角色（纯休整）；不期而遇=50% 无目标角色；其余节点照常抽取。
      // 去重口径：抽取前按**编队键精确匹配**排除已收服（见下方 pick；标本后缀键不挡本体，防"全身都是第一层的人"）。
      let preset = null;
      const layer = State.currentLayer;
      const poolLayer = this._poolForLayer(layer);
      // 干员开关筛网：先滤掉 jczl_custom 禁用的名字再抽（各池下限 5/2 已由拒绝逻辑保底）。
      // 编队精确去重：**键精确匹配**（防本局已收服的干员被重复刷出；标本后缀键 ≠ 本体名，
      // 如"阿米娅_3f"不挡住本体"阿米娅"，允许标本与本体重合出场）。
      // 回退只在**启用集**内进行：全被携带 → 容忍重复（防池被收空后节点无遭遇）；
      // 绝不回退到含禁用者的原池 —— 保持"禁用=永不参与随机"的硬契约（见模块2.7）。
      const carried = new Set();
      try { Object.keys((readVars(this.win)['干员编队']) || {}).forEach((n) => carried.add(n)); } catch (e) {}
      const pick = (list) => {
        const enabled = (list || []).filter((e) => isNameEnabled(this.win, e && e.name));
        let candidates = enabled.filter((e) => !carried.has(e && e.name));
        if (!candidates.length) candidates = enabled;   // 全被携带 → 容忍重复
        return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
      };
      // 隐藏关：只在「不期而遇」进节点时掷**一次**，结果冻结进 $切片.$隐藏关。
      // 先扫一遍收藏品置位，保证"该族已到手"的判断用的是最新状态（族内互斥/前置条件都读它）。
      let hiddenEv = null;
      if (type === '不期而遇') {
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
        : ('\n据此展开本段剧情，正文末尾以 <action_options> 给出选项。');
      // 新手建档战报（只有第一次通关前触发；可反复失败重开，每次新一局的第一个节点触发一次）：
      //   判定 = 本局第一个节点（确认并出发置真）&& 标本库为空（还没通关归档过任何干员 = 只能随机干员期）。
      //   作用 = 让 AI 用这一节点把「干员编队」里所有新手干员的一次性写全：清除占位、编造人设、年龄可破格。
      let noviceTxt = '';
      if (State.firstNodePending && !Object.keys(v['标本库'] || {}).length) {
        noviceTxt = '\n（新手建档：标本库为空，本局携带均为随机邂逅的新手干员，档案多为「待发掘/待初始化」占位。'
          + '用变量更新标签（updatevariable/update 等）为「干员编队」中每名干员一次性补齐完整档案：'
          + '外貌特征（年龄/身体特征/服装描述）、色情设定、经历记录、对玩家的态度。'
          + '年龄可破格，不限正史。）';
      }
      State.firstNodePending = false;   // 每局只消费一次
      // 诡意行商：独立于时空外的交易节点 —— 战报只写"进入<普瑞赛斯>的诡意行商节点"，
      // 不随机目标/年代/三轴战报，不写目标与年代类变量（普瑞赛斯已在世界书固定出现），购买可自由招募多名干员。
      const report = type === '诡意行商'
        ? (pendingNote ? pendingNote + '\n' : '') + this._sys('你进入了<普瑞赛斯>的诡意行商节点（' + nodeId + '）。' + noviceTxt + tail)
        : (pendingNote ? pendingNote + '\n' : '') + this._sys('你携带着' + (base ? ('<' + entryName + '>') : '（孤身）') + '，进入「' + type + '」（' + nodeId + '）。'
          + (encounter ? '\n此间遭遇了 ' + year + ' 年的<' + encounter.name + '>。' : '')
          + (hiddenEv ? '' : (noTargetTxt + presetTxt + guideTxt))
          + noviceTxt
          + tail);
      this.switchView('event_node');
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

    _leaveNode() {
      const nd = State.currentNodeData;
      const typeLabel = (nd && nd.type) || State.nodeType || '此节点';
      // 去向判定统一走 _resolveClear()（三态唯一口径）：普通/第3层 boss → 换层；
      // 第5层 boss 视冻结分支 → 结算或进第六层；第六层 boss → 结算。
      const out = this._resolveClear();
      const fin = out.kind === 'finish';
      if (fin || out.kind === 'enterHidden') State.pendingLeaveNote = ''; // 结算/进隐藏层都不接"回裂隙"前缀
      else if (!State.pendingLeaveNote) State.pendingLeaveNote = this._nodeLeaveNote(typeLabel);
      writeVars(this.win, (d) => { const a = d['行动'] = (d['行动'] && typeof d['行动'] === 'object') ? d['行动'] : {}; a.额外探索 = false; a.原定目标 = ''; });
      this._persistNodeSlice(null);
      this._resetNodeTransient();
      if (fin) {
        State.entryRoster = null; // 通关会合法清空编队并归档，无需恢复
        // 通关：归档进标本库 → 主城
        const baseBefore = ((readVars(this.win)._探索进程 || {}).$基底干员) || '';
        try { this._archiveRunToSpecimen(); } catch (e) { console.warn('[集成战略] 通关归档失败', e && e.message); }
        State.currentLayer = 1;
        State.mapCache = null;
        // 通关 → 本局变量整体复位（经济 + 干员编队 + 地图 + 节点切片 + 收藏品 + 行动 + 长期池 + 基底干员）。
        // 玩家回到开局界面重选编队时一切必为初始值，之后「确认并出发」再叠加难度/分队修正 →【重置 → 叠加】循环。
        writeVars(this.win, (d) => {
          this._resetRunScopedDraft(d);
          if (d['_全局资产']) d['_全局资产'].首次通关标记 = true;
        });
        State.nodeType = '';
        State.currentNodeData = null;
        this._resetPrepSelection();   // 内存侧同步复位（下次进编队界面从干净状态开始）
        this.switchView('out_of_game');
        setTimeout(() => Engine._sendAsUser(this.win, this._sys(this._layerName(nd && nd.layer) + '终局已了，你与' + (baseBefore ? ('<' + cleanName(baseBefore) + '>') : '众人') + '的羁绊归于罗德岛。恭喜通关。')), 200);
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
        setTimeout(() => Engine._sendAsUser(this.win, this._sys(
          '蚀刻章「' + HIDDEN_GATE.蚀刻章 + '」+收藏品「' + HIDDEN_GATE.收藏品 + '」触发' + this._layerName(HIDDEN_LAYER) + '。'
          + '单行线：紧急作战 → 诡意行商 → 不期而遇 → 险路恶敌。'
          + '末级首领固定<' + HIDDEN_BOSS + '>。打倒她=通关本局。据此展开。'
        )), 200);
      } catch (e) {
        console.warn('[集成战略] 进入隐藏层失败', e && e.message);
        this.switchView('map_navigation');
      }
    },

    _persistGameState(win) {
      const w = win || this.win;
      writeVars(w, (d) => {
        if (!d['_探索进程']) d['_探索进程'] = {};
        d['_探索进程'].$当前状态 = State.currentStatus || 'out_of_game';
        d['_探索进程'].$当前层数 = State.currentLayer || 1;
        const m = d['$地图状态'];
        if (m) m.层数 = State.currentLayer;
      });
    },

    _restoreGameState() {
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

    _failRun() {
      this.win.alert('本局已失败（核心生命归零）——返回主城，标本库等长线收藏保留。');
      this._resetRun();
      // 给 AI 一句收尾，避免它继续按未结束的探索推进（与紧急熔断一致）
      try {
        const self = this;
        setTimeout(() => { try { Engine._sendAsUser(self.win, self._sys('本局已失败（核心生命归零），本次探索就此终止，一切归于起点。')); } catch (e) {} }, 200);
      } catch (e) {}
    },

    /**
     * 前端失败判定：核心生命 ≤ 0 → 本局失败回主城。
     * 扣减完全由 AI 判定并写入变量，前端只读检测、不参与扣减；
     * 判定时机 = 收到 AI 回复后（_handleAiReply 调用）；重开恢复路径由 _restoreGameState 兜底。
     */
    _checkRunFailed() {
      try {
        if (!State.gameOpened) return false;
        if (State.currentStatus !== 'map_navigation' && State.currentStatus !== 'event_node') return false;
        const res = readVars(this.win)['玩家资源'] || {};
        if (res.核心生命 == null) return false;          // 未扣减（默认 10）→ 不算失败
        const hp = Number(res.核心生命);
        if (!isFinite(hp) || hp > 0) return false;
        this._failRun();
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
    },

    /** 「更多」按钮：往上多加载 CHAT_PAGE 条历史（显示条数翻倍式往上补）。 */
    _loadMoreChat() {
      State.chatVisible = Math.min(State.chatVisible + State.CHAT_PAGE, State.chatClean.length);
      this._renderChatWindow();
    },

    /** 修剪聊天正文中的隐藏标签块：metacognition/love_qkll 思考块、recap/safe 摘要块、update/updatevariable 变量块。 */
    _stripHiddenTags(text) {
      if (!text) return '';
      let t = text;
      // 思绪/约定块：[metacognition]…[/thinking] 或 [love_qkll]…，含换行与 <...> 变体。
      // 用户提供的原正则：/\[(?:metacognition|love_qkll)\]\s*((?:(?!\n(?:<\/thinking>|<content>)).)+)\s*\n(?:<\/thinking>|(?=<content>))/si
      t = t.replace(/\[(?:metacognition|love_qkll)\]\s*((?:(?!\n(?:<\/thinking>|<content>)).)+)\s*\n(?:<\/thinking>|(?=<content>))/si, '');
      // <recap>…</recap> 或 <safe>…</safe>（含到行尾无闭合的情况）
      t = t.replace(new RegExp('<(recap|safe)>(?:(?!.*</\\1>)(?:(?!<\\1>).)*$|(?:(?!<\\1>).)*</\\1?>)', 'gsi'), '');
      // <update>…</update> / <updatevariable>…</updatevariable>
      t = t.replace(new RegExp('<(update(?:variable)?)>(?:(?!.*</\\1>)(?:(?!<\\1>).)*$|(?:(?!<\\1>).)*</\\1?>)', 'gsi'), '');
      return t;
    },

    /** 白名单：提取 <content>…</content> 包裹的正文（仅 AI 输出使用）。
     *  只返回 content 块中的内容，标签本身一并剥除。
     *  ⚠ 之后再剥掉「选项类」结构化块：AI 有时会把 <action_options>/<options> 写进 <content> 里，
     *  那会让选项原文直接显示在聊天里（选项本身由 _parseActionOptions 渲染成右侧选项栏，不需要显示）。 */
    _extractContent(text) {
      if (!text) return '';
      const blocks = [];
      const re = /<content>([\s\S]*?)<\/content>/gi;
      let m;
      while ((m = re.exec(text)) !== null) blocks.push(m[1]);
      let t = blocks.join('\n');
      // 成对闭合的整块删（含各种大小写变体：options / option / Option / OptionN）
      t = t.replace(/<options?\b[^>]*>[\s\S]*?<\/options?\b[^>]*>/gi, '');
      // 未闭合的：吃到</content>（此处已无 content 标签）或文末
      t = t.replace(/<options?\b[^>]*>[\s\S]*$/i, '');
      // 残留的孤立开/闭标签本身
      t = t.replace(/<\/?options?\b[^>]*>/gi, '');
      // ⚠ 这里**不**脱 <角色名> 壳：说话人标签必须原样保留，
      // 下游 _galSplitGroups 要拿 <夏莲> 来匹配头像/名牌（脱壳统一在那一步做）。
      // 需要脱壳的路径（聊天记录显示）在调用方自行处理。
      return t.trim();
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
          // ① 首选白名单：<content>…</content> 包裹的正文（游戏约定格式）
          text = this._extractContent(m.message || '');
          if (!text || !text.trim()) {
            // ② 兜底：AI 没按 <content> 包裹（只写 <thinking>[metacognition] 加裸正文）——
            //    不能判定为"无正文"丢弃。剥掉思考/隐藏标签后，把剩余正文显示出来
            //    （也就是酒馆聊天界面里玩家实际看到的那段）。
            text = this._stripHiddenTags(m.message || '')
              .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')    // 完整闭合的 thinking 块
              .replace(/<thinking>/gi, '')                         // 孤立开标签（未闭合时留着也碍眼）
              .replace(/<\/thinking>/gi, '')                       // 孤立的闭标签
              .replace(/<action_options>[\s\S]*?<\/action_options>/gi, '')
              .replace(/<options?\b[^>]*>[\s\S]*?(?:<\/options?\b[^>]*>|$)/gi, '')
              .replace(/<\/?options?\b[^>]*>/gi, '')
              .trim();
            text = this._galStripNameTags(text).trim();            // 去说话人括号、名字保留
          }
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
     * 取一段末尾的 {指向角色} 锚点：最后一行尾部的 {...} → { key: 原样(含后缀), base: 最长匹配基底名 }。
     * 只认角色库真名（_matchKnownName）：{少女}/{她} 这类泛称 → ''（不匹配 → 头像无 + 立绘全暗）。
     */
    _galAnchorOf(raw) {
      const lines = String(raw || '').split('\n');
      let content = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /\{([^{}]*)\}\s*$/.exec(lines[i]);
        if (m) { content = String(m[1]).trim(); break; }
      }
      if (!content) return '';
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
      // 新协议：{指向角色} 锚点**连同内容一起删除**（与尖括号不同——尖括号留名字，大括号整个删）
      t = t.replace(/\{[^{}]*\}/g, '');
      // 半角尖括号：只脱壳，保留内部文本（含 </名字> 这类误写的闭合）
      t = t.replace(/<([^<>\n]{1,24})>/g, (full, inner) => {
        let raw = String(inner).trim();
        // 误写成 </名字> 的闭合标签：去掉前导斜杠，名字照留
        if (raw.charAt(0) === '/') raw = raw.slice(1).trim();
        // 尖括号里放的是「格式化/协议」关键字时不属于说话人标记 → 原样留着，别误吞
        if (/^(br|hr|p|b|i|em|strong|content|eventp|action_options|options?|thinking|sum|details|span|div)\b/i.test(raw)) return full;
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
      if (/^(br|hr|p|b|i|em|strong|content|eventp|action_options|options?|thinking|sum|details|span|div)\b/i.test(raw)) return '';
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
      this._galLayout();
      // 立绘同台层显隐跟随 gal 窗口（展开对话记录时一并隐藏）
      try { PortraitStage.setVisible(!!on); } catch (e) {}
    },

    /**
     * 让位计算（每次显示前调用）：不靠写死的像素，直接量真实元素——
     *   · 底部：让出输入行（#chat-input-area）实际高度 + 间隙，输入框/发送/停止不被压住；
     *     间隙桌面 8px；紧凑档 2px（手机上对话框与输入行之间那条缝要收紧，省出正文空间）；
     *   · 右侧：让出雷达列（.radar-panel 宽 + 边距），雷达不被压暗；无雷达时退回 260px
     *     （与 #chat-container 的 right 口径一致）。
     */
    _galLayout() {
      try {
        const d = this.win.document;
        const layer = d.getElementById('gal-layer');
        if (!layer) return;
        const ia = d.getElementById('chat-input-area');
        let ih = 0;
        if (ia && ia.getBoundingClientRect) ih = Math.round(ia.getBoundingClientRect().height);
        const gap = this.body.classList.contains('ui-compact') ? 2 : 8;
        layer.style.bottom = ((ih > 0 ? ih : 58) + gap) + 'px';
        let rw = 260;
        try {
          // 无雷达时退回「右侧列宽」令牌本身（桌面 260 / 紧凑档 176），不再写死 260 ——
          // 与 #chat-container 的 right 口径永远一致。
          const n = parseFloat(this.win.getComputedStyle(d.body).getPropertyValue('--right-col'));
          if (isFinite(n) && n > 0) rw = Math.round(n);
        } catch (e) {}
        const radar = d.getElementById('radar-panel');
        if (radar && radar.getBoundingClientRect) {
          const rect = radar.getBoundingClientRect();
          if (rect && rect.width > 0) rw = Math.round(rect.width + 16);
        }
        layer.style.right = rw + 'px';
      } catch (e) {}
      // 展开/收起按钮跟着底栏上沿走（紧凑档对话框比聊天面板高，必须一起重算）
      try { this._expandBtnLayout(); } catch (e) {}
      // 立绘层让位：实测 gal 层真实位置，避免 calc 乘法兼容性与 min-height 差异
      try { this._psLayout(); } catch (e) {}
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
      const gl = d.getElementById('gal-layer');
      const rect = gl && gl.getBoundingClientRect ? gl.getBoundingClientRect() : null;
      if (!rect || !rect.height) return;
      let overlap = 30;   // 与 CSS --ps-overlap 保持一致
      try { const o = parseFloat(this.win.getComputedStyle(d.body).getPropertyValue('--ps-overlap')); if (isFinite(o) && o >= 0) overlap = o; } catch (e) {}
      const drop = Math.max(0, Math.round(this.win.innerHeight * 0.24));   // 下移量：整屏 24%（作者拍板，可调）
      const bottomFromTop = rect.top + overlap + drop;                    // 立绘底部锚点（视口坐标）
      let barH = 48;
      try { const b = parseFloat(this.win.getComputedStyle(d.body).getPropertyValue('--bar-h')); if (isFinite(b) && b > 0) barH = b; } catch (e) {}
      // 防御钳制（正常值下 bft === bottomFromTop，零视觉变化；极端输入才介入）：
      //   · 下限 barH+120 —— 保证 h 取下限 120 时元素顶仍贴顶栏，**绝不顶出顶端**；
      //   · 上限 innerHeight-8 —— 底部锚点不侵入输入行，bottom 不会为负。
      // 由此 h = bft-barH 恒 ≥120（保留"不过小"下限），顶恒 = barH。
      const bft = Math.max(barH + 120, Math.min(bottomFromTop, this.win.innerHeight - 8));
      stage.style.bottom = Math.round(this.win.innerHeight - bft) + 'px';
      stage.style.height = Math.round(bft - barH) + 'px';
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
          const base = (g && g.anchor && g.anchor.base) || _matchBaseName(nm);
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
        干员开关: (() => { // jczl_custom 开关筛网状态（Shift+G 排查用）
          try {
            const c = readJczlCustom(this.win);
            const off = CUSTOM_NAMES.filter((nm) => c[nm] === false);
            return '禁用 ' + off.length + ' / ' + CUSTOM_NAMES.length + (off.length ? '（' + off.slice(0, 6).join('、') + (off.length > 6 ? '…' : '') + '）' : '');
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
          // 优先 <content> 白名单；没有就剥隐藏标签取剩余正文
          let t = this._extractContent(m.message || '').trim();
          if (!t || t === '◇') {
            t = this._stripHiddenTags(m.message || '')
              .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
              .replace(/<thinking>/gi, '').replace(/<\/thinking>/gi, '')
              .replace(/<action_options>[\s\S]*?<\/action_options>/gi, '')
              .replace(/<options?\b[^>]*>[\s\S]*?(?:<\/options?\b[^>]*>|$)/gi, '')
              .trim();
            t = this._galStripNameTags(t).trim();
          }
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
      State.pendingSend = true;
      State.armed = true; State.armedAt = Date.now();      // 白名单：本端发起，等待 STARTED 认领
      State.pendingNoBusyUntil = 0;                        // 清零忽略窗口，放行随后的 GENERATION_STARTED
      let raw = rawBase;
      try {
        // 无对手不开战：不期而遇有 50% 概率无目标角色，此间不存在可打的人 →
        // 即便文本命中关键词也不拼战报（否则会生成一张"没有对手"的空战报）。
        if (BATTLE_KEYWORD_RE.test(raw) && this._nodeHasTarget() && this._isUnexpectedNode()) {
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
      this._recomputeLongPool(); // AI 可能刚写入新收藏品/改数值 → 先重算长期池
      // 失败判定：AI 回复即扣减核心生命的唯一时机；≤0 → 判定失败回主城，不再继续处理该回复
      if (this._checkRunFailed()) return;
      this._auditNodeVariant();  // 检查"额外收服"是否已入库 → 决定锁定/弹出
      this._updateNodeLeaveGate(); // 战斗节点收服主目标后补出离开卡（未通关不出现）
      this._syncEtchBadges();      // 蚀刻章：编队/遭遇都由变量驱动，每次回复后兜底判定（幂等，已有则不触发）
      this.refreshStats();         // 顶栏数值 + 层数罗马数字 + 常驻右下角三轴雷达（节点内外均按最新值刷新）
      this.loadHistoryChat();
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
      };
      // 收束（$锁定）态：正文选项与输入一律锁死，选项栏只渲染「离开节点」卡（本节点唯一出口是离开）
      if (this._nodeLocked()) {
        const r = this.win.document.getElementById('option-rail');
        if (r) r.remove();
        this.body.classList.remove('has-option-rail');
        this._ensureLeaveCard();
        return;
      }
      const leave = this._showLeaveCard();   // 节点内是否渲染离开卡（战斗未通关 / 诡意行商 / 非节点视图 = false）
      const m = /<action_options>([\s\S]*?)<\/action_options>/i.exec(raw || '');
      const strip = (s) => String(s || '').trim().replace(/^【/, '').replace(/】$/, '').trim();
      const items = [];
      let cur = null;
      if (m) {
        m[1].split('\n').forEach((line) => {
          const t = line.trim();
          if (!t) return;
          if (/^System\s*:/i.test(t)) return; // System: 前缀行忽略
          const titleM = /^(\d+)\s*[:：]\s*(.+)$/.exec(t);
          if (titleM) {
            cur = { n: Number(titleM[1]), title: strip(titleM[2]), desc: '' };
            items.push(cur);
            return;
          }
          const descM = /^(?:简介|说明)\s*[:：]\s*(.+)$/.exec(t);
          if (descM && cur) cur.desc = descM[1].trim();
        });
      }
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
        rail.appendChild(b);
      });
      if (leave) this._appendLeaveCard(rail);   // 离开卡恒排末尾（若 _showLeaveCard）
      this.body.classList.add('has-option-rail');
    },

    /**
     * 点击选项：把所选文本作为 user 消息发出（可附上输入框内尚未发送的个人输入），触发 AI。
     * 效果由 AI 收到后自行修改变量（前端不再执行任何效果）。
     */
    _pickActionOption(it) {
      if (this._nodeLocked()) return;
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
      // 草稿命中战斗关键词：确认后、发送前拼战报（与玩家发送出口同规则，System 路径兜底不遗漏）
      // 同样加"无对手不开战"守卫：不期而遇无目标角色时，此间没有可打的人。
      if (draft && BATTLE_KEYWORD_RE.test(combined) && Router._nodeHasTarget() && Router._isUnexpectedNode()) {
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
