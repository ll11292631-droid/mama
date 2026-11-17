/**
 * ============================================================================
 * corpse_ball.paste.js —— 尸检报告 · 悬浮球全屏面板版
 * ============================================================================
 * 可直接粘贴进酒馆助手「脚本内容」栏的纯 JS 版本 (无 import / require / 构建步骤,
 * 也不需要 Vue / tailwind / jQuery)。
 *
 * 它把 src/corpse_data_ui/corpse7_debug.js 的全部面板逻辑 (部位热点、四视图、
 * 受检者档案、改造选项、细则输入、上限限制、指令生成与写输入框) 搬进了一个
 * 由悬浮球召唤的「全屏 iframe 面板」, 并且完全脱离了楼层内渲染:
 *
 *   1. 不再往消息楼层里注入任何 DOM, 也不再理会正文里的 [[corpse_data]] 标签
 *      (标签由你自己的纯前端正则剪除), 因此不需要 retrieveDisplayedMessage、
 *      不需要等楼层渲染、不需要处理渲染位置与锚定。
 *
 *   2. 数据只来自「酒馆最后两层消息」: 用 getChatMessages(-2) / getChatMessages(-1)
 *      读原始消息文本, 解析其中所有 [[corpse_data]]…[[/corpse_data]] 块。
 *      多个块取其并集并去重: 同名角色按「后楼层覆盖前楼层、部位取并集」合并成
 *      一个角色; 顶边栏的角色胶囊可以随时切换。
 *
 *   3. 改造项仍然写进酒馆真实的输入框 (#send_textarea), 面板下边缘的 tag 堆
 *      与输入框、与面板选项三者互相同步:
 *        · 点选项 → 下边缘多一个 tag → 输入框更新为最新指令文本
 *        · 点 tag 上的 × → 取消该选项 → 输入框同步更新
 *        · 改「附加细则」输入 → tag 文字与输入框一起更新
 *        · 手动改/清空酒馆输入框 → 尽力反向解析, tag 堆与已选项跟着变
 *       (反向解析只认本脚本自己生成的指令格式, 解析不出来就保持原样、绝不乱删)
 *
 *   4. 面板画在酒馆网页的一个 srcdoc iframe 里, 样式与酒馆完全隔离。
 *      宽屏: 左边大图 + 右边受检者档案栏, 操作面板浮在图片右侧;
 *      窄屏: 图片铺满, 档案收进「档案」按钮, 操作面板变成底部半透明抽屉。
 *      两种布局里点部位按钮都只会召唤叠在图片上的浮层, 不需要上下来回划动。
 *
 *   5. 内置《前任法医的操作笔记》(原 操作手册.html 的 5 个分页内容全保留),
 *      挂在右下角常驻的小圆按钮 📝 上, 点开是覆盖层, 平时完全不占地方。
 *
 * 保留的老逻辑 (一处没删): MAX_SELECT=10 上限与提示、部位名 → 小穴/后庭/口部
 * 归组、备注型选项 (CUSTOM_OPTIONS) 才出细则输入框、指令文本格式
 * 「进行{姓名}的改造+同时把玩的剧情，改造指令：（部位）：（选项、…）」、
 * 年龄 → 特写图分组 (111/222/333/444)、localStorage 的 mvu_char_img_cache 立绘、
 * 部位名与内置坐标表不一致时跳过该热点。
 *
 * 交互速查:
 *   · 悬浮球可拖动, 位置记在脚本变量里, 刷新网页后仍在; 点它打开全屏面板。
 *   · 脚本按钮「🔬 尸检面板」可直接打开面板,「🟢 尸检球开关」显示/隐藏悬浮球。
 *   · 顶边栏: 角色胶囊切换角色 / ↻ 重新拉取最后两层 / 档案 / × 关闭。
 *   · 关闭途径: 右上角 × / Esc (先关浮层, 再关面板)。
 *   · 控制台接口 window.__corpseBall: open / close / refresh / state / getCommand。
 * ============================================================================
 */

(() => {
  'use strict';

  // ============================================================================================
  // 可调参数
  // ============================================================================================

  /** 控制台日志前缀 */
  const LOG_PREFIX = '[corpse_ball]';
  /** 标记本脚本插入宿主网页的所有 DOM, 脚本重载时据此清理上一次的残留 */
  const MARK = 'data-corpse-ball';
  /** 位移超过这个像素数才算拖动, 否则算点击 */
  const DRAG_THRESHOLD = 6;
  /** 悬浮球与视口边缘的留白 (px) */
  const EDGE_PADDING = 8;
  /** 悬浮球默认直径 (px) */
  const DEFAULT_BALL_SIZE = 56;
  /** 面板淡出耗时 (ms) */
  const PANEL_FADE_MS = 200;
  /** 一次最多选几项改造 (老面板的硬限制, 原样保留) */
  const MAX_SELECT = 10;
  /** 只读取酒馆最后几层消息 */
  const DEPTH_FLOORS = 2;
  /** 主图是 7:9 竖版: 画面框与按钮阵列都按这个比例内切排布 */
  const FRAME_RATIO = 7 / 9;
  /** 画面框比这更窄时, 部位浮层改成底部抽屉 */
  const NARROW_FRAME_WIDTH = 430;
  /** 可用宽度超过这个值才考虑把受检者档案并排放在图片右边 */
  const SIDE_BREAKPOINT = 640;
  /** 并排后图片宽度小于这个值就撤掉档案栏, 把空间还给图片 */
  const SIDE_MIN_FRAME = 340;
  /** 档案栏宽度 (与 CSS 里的 .cp-side width 保持一致) */
  const SIDE_WIDTH = 300;
  /** 图片与档案栏之间的间距 (与 CSS 里的 .cp-body gap 一致) */
  const SIDE_GAP = 16;
  /** 主区域留白 (与 CSS 里的 .cp-body padding 一致) */
  const BODY_PADDING = 10;
  /** 自愈巡检间隔 (ms): 万一宿主把我们的 DOM 摘掉/重建, 靠它长回来 */
  const WATCHDOG_MS = 1200;
  /**
   * 本实例的所有权标记。酒馆/酒馆助手在窗口缩放、切前端界面时可能重载脚本,
   * 重载后新实例会接管; 旧实例看到标记不是自己就安静退场,
   * 免得两个实例来回抢 DOM (重复悬浮球 / 幽灵面板)。
   */
  const INSTANCE_TOKEN = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const OWNER_ATTR = 'data-corpse-ball-owner';
  /** 酒馆输入框的候选选择器 (老面板的 4 个候选里去掉楼层内的那个) */
  const INPUT_SELECTORS = ['#send_textarea', '#send_text', 'textarea.send_textarea'];
  /** 指令文本的固定中段, 与老面板 corpse7.js 的 G() 逐字一致 */
  const CMD_MID = '的改造+同时把玩的剧情，改造指令：';
  /** 脚本按钮: 打开面板 / 开关悬浮球 */
  const OPEN_PANEL_BUTTON = '🔬 尸检面板';
  const BALL_TOGGLE_BUTTON = '🟢 尸检球开关';

  // ============================================================================================
  // 数据源 (逐字取自 corpse7_debug.js, 勿改)
  // ============================================================================================

  /** 性别/年龄分组的局部特写底图 (小穴 / 后庭 / 口部) */
  const LOCAL_BG = {
    111: [
      'https://cdn.imgchest.com/files/81f2834ce55c.jpg',
      'https://cdn.imgchest.com/files/05be39103a5a.jpg',
      'https://cdn.imgchest.com/files/045cc1a1a796.jpg',
    ],
    222: [
      'https://cdn.imgchest.com/files/28161ddf05f6.jpg',
      'https://cdn.imgchest.com/files/3938179126ee.jpg',
      'https://cdn.imgchest.com/files/045cc1a1a796.jpg',
    ],
    333: [
      'https://cdn.imgchest.com/files/f1eb85dca294.jpg',
      'https://cdn.imgchest.com/files/3938179126ee.jpg',
      'https://cdn.imgchest.com/files/5abb4d64c529.jpg',
    ],
    444: [
      'https://cdn.imgchest.com/files/b2f3bd821982.jpg',
      'https://cdn.imgchest.com/files/69308377e18d.jpg',
      'https://cdn.imgchest.com/files/5abb4d64c529.jpg',
    ],
  };

  /** 小穴视图的部位 (热点名) */
  const SP_XIAOXUE = [
    '小穴腺体', '阴唇', '肚脐', '子宫', '小穴宫颈', '小穴后段', '小穴中段', '阴蒂', '小穴口', '卵巢', '穴道整体', '阴户',
  ];
  /** 后庭视图的部位 */
  const SP_HOUTING = ['臀瓣', '后庭腺体', '直肠', '后庭后段', '后庭中段', '菊口', '肛周', '后庭整体'];
  /** 口部视图的部位 */
  const SP_KOUBU = [
    '嘴角', '嘴唇', '牙齿', '口腔', '小舌', '喉部', '舌头', '舌尖', '深喉形态', '终点设定', '口部腺体', '神经反射',
  ];
  /** 全身视图的部位 */
  const PART_MAIN = [
    '脑部', '眼部', '声带', '颈部', '胸部', '血管', '内脏', '骨骼', '肌肉', '皮肤', '气味', '淫纹', '四肢', '伤口',
    '整体', '外观', '限量改造',
  ];
  /** 受检者档案里优先展示的字段顺序 */
  const PROFILE_KEYS = ['年龄', '身高', '身材', '罩杯', '发色', '发型', '瞳色', '容貌', '背景身份', '死因'];

  /** 部位热点坐标 (百分比, 与老面板完全一致) */
  const HOTSPOT_COORDS = {
    脑部: { left: '55%', top: '11%' },
    眼部: { left: '38%', top: '16%' },
    声带: { left: '78%', top: '22%' },
    颈部: { left: '66%', top: '22%' },
    血管: { left: '55%', top: '34%' },
    胸部: { left: '32%', top: '41%' },
    内脏: { left: '55%', top: '48%' },
    骨骼: { left: '68%', top: '51%' },
    肌肉: { left: '28%', top: '56%' },
    皮肤: { left: '72%', top: '58%' },
    气味: { left: '86%', top: '18%' },
    淫纹: { left: '57%', top: '70%' },
    四肢: { left: '18%', top: '71%' },
    伤口: { left: '78%', top: '46%' },
    整体: { left: '12%', top: '14%' },
    外观: { left: '88%', top: '14%' },
    限量改造: { left: '55%', top: '96%' },
    小穴腺体: { left: '20%', top: '60%' },
    阴唇: { left: '20%', top: '70%' },
    肚脐: { left: '40%', top: '15%' },
    子宫: { left: '40%', top: '24%' },
    小穴宫颈: { left: '40%', top: '33%' },
    小穴后段: { left: '40%', top: '42%' },
    小穴中段: { left: '40%', top: '60%' },
    阴蒂: { left: '40%', top: '69%' },
    小穴口: { left: '40%', top: '78%' },
    卵巢: { left: '80%', top: '40%' },
    穴道整体: { left: '80%', top: '60%' },
    阴户: { left: '80%', top: '70%' },
    臀瓣: { left: '20%', top: '20%' },
    后庭腺体: { left: '20%', top: '40%' },
    直肠: { left: '40%', top: '24%' },
    后庭后段: { left: '40%', top: '33%' },
    后庭中段: { left: '40%', top: '42%' },
    菊口: { left: '40%', top: '60%' },
    肛周: { left: '80%', top: '50%' },
    后庭整体: { left: '80%', top: '60%' },
    嘴角: { left: '20%', top: '50%' },
    嘴唇: { left: '40%', top: '15%' },
    牙齿: { left: '40%', top: '24%' },
    口腔: { left: '40%', top: '33%' },
    小舌: { left: '40%', top: '42%' },
    喉部: { left: '40%', top: '51%' },
    舌头: { left: '40%', top: '60%' },
    舌尖: { left: '40%', top: '69%' },
    深喉形态: { left: '80%', top: '30%' },
    终点设定: { left: '80%', top: '40%' },
    口部腺体: { left: '80%', top: '60%' },
    神经反射: { left: '80%', top: '70%' },
  };

  /** 各部位可选的改造项 (与老面板完全一致) */
  const OPTIONS = {
    血管: ['红色药剂', '白色药剂', '青色药剂'],
    内脏: ['硅胶填充', '液囊填充', '气囊填充', '内部加热'],
    骨骼: ['骨折固定件', '关节固定件', '额外关节件', '全身软骨替换', '弹性版', '塑性版'],
    肌肉: ['基础处理', '紧致', '松软', '半塑化'],
    皮肤: ['光滑', '磨砂', '乳胶', '丝绸', '汗腺替换', '防水涂层', '透明窗口'],
    气味: ['除臭', '定制体香'],
    声带: ['被动触发型', '智能播放型'],
    脑部: ['脑姦改造', '脑震改造', '应激低智能性爱反应'],
    颈部: ['可拆卸头颅', '永久斩首', '超可动颈椎'],
    眼部: ['眼交改造', '荧光瞳孔 (形/色)'],
    胸部: ['乳腺改造', '穴道改造', '丰胸', '色素净化'],
    淫纹: ['发热', '发光', '催情魅惑', '凸起', '颜色', '形态'],
    四肢: ['截肢', '可拆卸肢体', '义肢', '玉足保养', '手交反射', '触手附肢'],
    伤口: ['无痕缝合', '有痕缝合', '假体填充', '另造穴道'],
    整体: [
      '内外清洗', '全身加热植入', '全身散热植入', '灭活', '体毛去除', '腰斩', '塑化', '家具化', '精液背包', '其他',
      '懒人套餐',
    ],
    外观: ['兽耳', '兽尾', '精灵耳', '天使翼', '恶魔角', '恶魔翼', '恶魔尾', '染发', '美瞳', '纹身'],
    限量改造: ['S病毒', '智械', '灵异注入', '尸体孕育'],
    小穴腺体: ['性状', '口味', '功效', '自洁酶', '尿液定制'],
    阴唇: ['收紧', '扩大', '异形', '去色素'],
    肚脐: ['子宫通道', '填平', '饮品吸管'],
    子宫: ['孕肚', '长丝绒', '生物电单元', '电击单元', '定制'],
    小穴宫颈: ['马眼肉针', '吸盘', '开放', '单向', '生物电单元', '电击单元', '触手', '环路', '肉粒', '旋纹', '定制'],
    小穴后段: ['电击单元', '触手', '环路', '肉粒', '旋纹', '龟头契合沟', '加紧', '放松', '定制'],
    小穴中段: ['电击单元', '触手', '环路', '肉粒', '旋纹', '网状软沼', '加紧', '放松', '定制', '复用处女'],
    阴蒂: ['常驻勃起', '小巧', '加大', '高潮触发', '定制'],
    小穴口: ['加紧', '放松', '去色素', '真空亲吻箍', '尿道扩张', '尿道塞'],
    卵巢: ['液化', '卵子保鲜'],
    穴道整体: ['生物电单元', 'S形', '宽窄波浪', '正反运动', '潮喷强化'],
    阴户: ['除毛', '馒头', '松软'],
    臀瓣: ['填充', '弹性', '放松', '对夹'],
    后庭腺体: ['性状', '口味', '功效', '人造排泄', '自洁酶'],
    直肠: ['人造肛颈', '肛口直通', '吸盘', '肛阴造瘘', '生物电单元', '电击单元'],
    后庭后段: ['电击单元', '触手', '环路', '肉粒', '旋纹', '龟头契合沟', '加紧', '放松', '定制'],
    后庭中段: ['电击单元', '触手', '环路', '肉粒', '旋纹', '加紧', '放松', '定制'],
    菊口: ['加紧', '放松', '去色素'],
    肛周: ['平滑', '褶皱', '除毛'],
    后庭整体: ['S形', '生物电单元'],
    嘴角: ['裂口', '缝合'],
    嘴唇: ['湿润', '丰唇'],
    牙齿: ['拔除', '磨平', '尖牙'],
    口腔: ['生物电单元', '电击单元', '触手', '肉粒', '旋纹'],
    小舌: ['切除', '电击单元'],
    喉部: ['触手', '环路', '肉粒', '旋纹', '加紧', '放松', '定制'],
    舌头: ['壁虎式吸盘', '触手', '延长'],
    舌尖: ['分叉', '电击单元'],
    深喉形态: ['电击单元', '触手', '环路', '肉粒', '旋纹', '加紧', '放松', '定制'],
    终点设定: ['瓶颈', '胃部蓄精囊', '肛口直通'],
    口部腺体: ['性状', '口味', '功效', '自洁酶'],
    神经反射: ['干呕', '流涎', '吞咽'],
  };

  /** 需要「附加细则」输入框的选项 (与老面板的 N 表一致) */
  const CUSTOM_OPTIONS = [
    '外阴整形', '骨折固定件', '关节固定件', '额外关节件', '被动触发型', '智能播放型', '定制体香', '脑姦改造',
    '荧光瞳孔 (形/色)', '液腺替换', '乳腺改造', '丰胸', '尿液替换', '人造排泄', '截肢', '可拆卸肢体', '义肢',
    '触手附肢', '另造穴道', '腰斩', '兽耳', '兽尾', '染发', '美瞳', '纹身', '塑化', '家具化', '其他', '颜色',
    '形态', '定制', '性状', '口味', '功效', '饮品吸管', '异形', '透明窗口', '尿液定制', '汗腺替换',
  ];

  /** 四个视图: key / 标签 / 部位表 / 局部底图下标 (-1 = 角色立绘) */
  const PANES = [
    { key: 'main', label: '全身', parts: PART_MAIN, bg_index: -1 },
    { key: 'xiaoxue', label: '小穴', parts: SP_XIAOXUE, bg_index: 0 },
    { key: 'houting', label: '后庭', parts: SP_HOUTING, bg_index: 1 },
    { key: 'koubu', label: '口部', parts: SP_KOUBU, bg_index: 2 },
  ];

  // ============================================================================================
  // 内置操作手册 (原 操作手册.html 的全部实质内容, 外观改造成与面板一致)
  // ============================================================================================

  const MANUAL_PAGES = [
    {
      label: '流程',
      blocks: [
        {
          type: 'section',
          title: '操作流程（严格按顺序）',
          items: [
            { k: '1. 开工指令：', v: '喊"开始改造"，挂载状态界面。' },
            {
              k: '2. 整体处理（必须先做）：',
              v: '除臭、防腐、软化。或者直接用"懒人套餐"一键搞定。不做这步尸体没法用。',
            },
            {
              k: '3. 开膛植入（核心）：',
              v: '内脏摘取填充，各种穴道定制植入。这步要切开肉，所以必须在缝合前做！',
            },
            { k: '4. 缝合与外观（收尾）：', v: '伤口缝合、皮肤涂层、发色美瞳等。' },
            { k: '5. 完工指令：', v: '喊"改造完成"，脱离操作界面。' },
          ],
        },
        {
          type: 'note',
          text: '“别他妈这改一点那改一点，按顺序来。部位挑3-5个重点就够，堆太多写起来像产品说明书。”',
        },
        { type: 'note', text: '有想卖的就直接说想卖，会有买家联系，有的要送货，有的上门验货' },
      ],
    },
    {
      label: '整体处理',
      blocks: [
        {
          type: 'section',
          title: '基础质感',
          items: [
            {
              k: '血管（红/白/青色药剂）：',
              v: '恢复活人红润血色 / 赋予冷白瓷器质感 / 浮现皮下血管呈异质感。',
            },
            { k: '半塑化（肌肉）：', v: '消除组织回弹力，受压或使用后长期保留凹陷与变形痕迹。' },
            { k: '全身软骨替换（骨骼）：', v: '剔除硬骨结构，替换为柔性支撑，躯体可任意折叠盘绕。' },
          ],
        },
        {
          type: 'section',
          title: '形体与机制',
          items: [
            { k: '灭活：', v: '彻底抹除生前病原体与残余反应（与S病毒物理互斥）。' },
            { k: '家具化：', v: '将躯干或肢体固定，与日常家具（如座椅、灯具）进行物理嵌合。' },
            { k: '精液背包：', v: '将四肢与躯干进行极限折叠固化，体积缩减至可装入常规箱包。' },
          ],
        },
      ],
    },
    {
      label: '小穴改造',
      blocks: [
        { type: 'note', text: '“通用组件注：生物电、触手等形态改造组件，同样适用于后庭与口腔深处。”' },
        {
          type: 'section',
          title: '通用腔道组件',
          items: [
            { k: '生物电单元：', v: '促使肉壁产生自主节律性蠕动与挤压。' },
            { k: '触手：', v: '内壁覆有硅胶触须，物理探入时主动缠绕。' },
            { k: '龟头契合沟：', v: '内壁预设凹槽，顶端深入时精确卡入冠状沟锁定。' },
          ],
        },
        {
          type: 'section',
          title: '宫颈与子宫',
          items: [
            { k: '开放（宫颈）：', v: '移除宫颈屏障，建立直达子宫的无阻力通道。' },
            { k: '马眼肉针（宫颈）：', v: '细长柔韧硅胶刺，顶端接触时精确刺入尿道。' },
            { k: '孕肚（子宫）：', v: '强制柔性填充子宫，使腹部呈现流畅的孕期隆起。' },
          ],
        },
      ],
    },
    {
      label: '后庭改造',
      blocks: [
        {
          type: 'section',
          title: '肠道机制',
          items: [
            { k: '人造排泄：', v: '肠道预置胶状物，受外部物理推挤时自菊口排出。' },
            { k: '人造肛颈：', v: '于直肠深处植入仿宫颈的环状狭窄结构，提供撞击阻力反馈。' },
            { k: '肛阴造瘘：', v: '穿透直肠与阴道之间的组织壁，形成可同时贯穿两穴的通道。' },
          ],
        },
      ],
    },
    {
      label: '口部/头部',
      blocks: [
        {
          type: 'section',
          title: '头部重度改造',
          items: [
            { k: '脑姦改造：', v: '脑组织凝胶化处理，于颅骨开孔建立可探入的通道。' },
            { k: '眼交改造：', v: '摘除眼球并以覆膜构建腔道，闭眼时外观维持原状。' },
          ],
        },
        {
          type: 'section',
          title: '神经与发声',
          items: [
            { k: '应激低智能：', v: '刺激残余神经，受限时自动产生翻白眼与流涎等低级反射。' },
            { k: '被动触发声带：', v: '受物理挤压驱动的发声组件，音量与力度正相关。' },
          ],
        },
      ],
    },
  ];

  // ============================================================================================
  // 悬浮球 / 面板容器样式 (注入酒馆网页本身; 类名统一 cpb- 前缀)
  // ============================================================================================

  const BALL_CSS = `
.cpb-ball {
  position: fixed !important;
  z-index: 9999990 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 999px;
  background: radial-gradient(circle at 32% 26%, #a9dfea 0%, #4b8fa4 46%, #16323c 100%);
  box-shadow: 0 6px 20px rgba(10, 40, 52, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.5);
  color: #fff;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.16s ease, opacity 0.16s ease, box-shadow 0.16s ease;
  will-change: left, top, transform;
}
.cpb-ball::after {
  content: '';
  position: absolute;
  inset: -6px;
  border: 2px solid rgba(169, 223, 234, 0.55);
  border-radius: inherit;
  animation: cpb-pulse 2.4s ease-out infinite;
  pointer-events: none;
}
.cpb-ball:hover {
  box-shadow: 0 8px 26px rgba(10, 40, 52, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.6);
  transform: scale(1.06);
}
.cpb-ball:active { transform: scale(0.94); }
.cpb-ball__icon { width: 54%; height: 54%; pointer-events: none; }
.cpb-ball--dragging { cursor: grabbing; transition: none; transform: scale(1.02); }
.cpb-ball--dragging::after { animation: none; opacity: 0; }
.cpb-ball--hidden { opacity: 0; pointer-events: none; transform: scale(0.6); }

.cpb-panel {
  position: fixed !important;
  inset: 0 !important;
  z-index: 9999999;
  background: rgba(3, 6, 10, 0.5);
  opacity: 1;
  transition: opacity ${PANEL_FADE_MS}ms ease;
}
.cpb-panel--closing { opacity: 0; }
.cpb-panel__iframe {
  position: absolute !important;
  inset: 0 !important;
  display: block;
  width: 100% !important;
  height: 100% !important;
  border: 0 !important;
  background: transparent;
}

@keyframes cpb-pulse {
  0% { opacity: 0.85; transform: scale(0.88); }
  70% { opacity: 0; transform: scale(1.18); }
  100% { opacity: 0; transform: scale(1.18); }
}
`;

  // ============================================================================================
  // 全屏面板样式 (写进面板 iframe 的 srcdoc, 与酒馆网页完全隔离)
  // ============================================================================================

  const PANEL_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: transparent; }
button { font-family: inherit; color: inherit; }
[hidden] { display: none !important; }

.cp-app {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  color: #e8e4dc;
  font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.45;
  background:
    radial-gradient(120% 80% at 8% 0%, rgba(91, 138, 154, 0.22), transparent 58%),
    radial-gradient(100% 70% at 100% 100%, rgba(140, 90, 90, 0.1), transparent 60%),
    linear-gradient(180deg, #121820 0%, #0d1218 55%, #080b0e 100%);
  -webkit-tap-highlight-color: transparent;
}

/* ---------------- 顶边栏 ---------------- */
.cp-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(8, 12, 17, 0.66);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.cp-brand { flex: none; display: flex; align-items: center; gap: 7px; }
.cp-brand b { font-size: 14px; letter-spacing: 0.04em; color: #dce9ee; white-space: nowrap; }
.cp-brand__dot {
  width: 8px; height: 8px; border-radius: 999px; background: #5b8a9a;
  box-shadow: 0 0 9px rgba(91, 138, 154, 0.95);
}
.cp-brand__tag { font-size: 11px; color: #8ea6ae; white-space: nowrap; }
.cp-chars {
  flex: 1 1 auto; min-width: 0; display: flex; gap: 6px; overflow-x: auto; padding: 2px 0;
  scrollbar-width: none;
}
.cp-chars::-webkit-scrollbar { display: none; }
.cp-char {
  flex: none; display: flex; align-items: baseline; gap: 5px; padding: 4px 10px;
  border-radius: 999px; border: 1px solid rgba(91, 138, 154, 0.32);
  background: rgba(91, 138, 154, 0.09); color: #b6c6cc; font-size: 12px;
  cursor: pointer; transition: 0.15s;
}
.cp-char b { font-weight: 600; }
.cp-char small { font-size: 10px; opacity: 0.62; }
.cp-char:hover { border-color: rgba(91, 138, 154, 0.6); }
.cp-char.is-on {
  background: rgba(91, 138, 154, 0.42); border-color: #a9cbd6; color: #f4f0e8;
  box-shadow: inset 0 0 0 1px rgba(169, 203, 214, 0.25);
}
.cp-chars__empty { font-size: 11px; color: #7a8d95; padding: 4px 6px; }
.cp-tools { flex: none; display: flex; gap: 6px; }
.cp-ico {
  min-width: 32px; height: 30px; padding: 0 9px; border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.05);
  color: #cbd8dd; font-size: 12px; cursor: pointer; transition: 0.15s;
}
.cp-ico:hover { background: rgba(91, 138, 154, 0.28); border-color: rgba(169, 203, 214, 0.5); }
.cp-ico--danger { color: #ffb4b4; border-color: rgba(255, 120, 120, 0.36); background: rgba(255, 80, 80, 0.12); }
.cp-ico--danger:hover { background: rgba(255, 80, 80, 0.26); }

/* ---------------- 主区域: 7:9 竖版画面框 (内切于可用区域, 永不超出屏幕) ---------------- */
.cp-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 10px;
}
.cp-media {
  flex: 0 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* 画面框: 宽高由 layoutFrame() 按 7:9 精确计算, 因此图片与按钮阵列严格同比例 */
.cp-frame {
  position: relative;
  flex: none;
  overflow: hidden;
  background: #05080b;
  border-radius: 12px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.cp-canvas {
  position: absolute; inset: 0; background-color: #05080b;
  background-size: cover; background-position: center top; background-repeat: no-repeat;
  transition: background-image 0.4s ease;
}
.cp-vignette {
  position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 76% 92% at 50% 30%, transparent 0%, rgba(6, 10, 14, 0.42) 62%, rgba(3, 6, 9, 0.93) 100%);
}
.cp-hotspots { position: absolute; inset: 0; }
.cp-tabs {
  position: absolute; left: 0; right: 0; top: 0; z-index: 25;
  display: flex; gap: 6px; padding: 8px 10px; overflow-x: auto; scrollbar-width: none;
  background: linear-gradient(180deg, rgba(3, 6, 9, 0.82), rgba(3, 6, 9, 0));
}
.cp-tabs::-webkit-scrollbar { display: none; }
.cp-tab {
  flex: none; padding: 4px 12px; border-radius: 999px; font-size: 12px;
  border: 1px solid rgba(255, 255, 255, 0.15); background: rgba(8, 12, 18, 0.55);
  color: rgba(255, 255, 255, 0.62); cursor: pointer; transition: 0.15s;
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
}
.cp-tab:hover { color: #fff; border-color: rgba(255, 255, 255, 0.35); }
.cp-tab.is-on { color: #f4f0e8; border-color: #7fb0c0; background: rgba(91, 138, 154, 0.55); }

/* ---------------- 部位按钮 (热点) ---------------- */
.cp-hotspot {
  position: absolute; transform: translate(-50%, -50%);
  display: inline-flex; align-items: center; gap: 3px;
  padding: 3px 8px; max-width: 6.5em; font-size: 11px;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 2px #000, 0 0 3px #000;
  background: rgba(10, 16, 22, 0.42);
  border: 1px solid rgba(91, 138, 154, 0.55); border-radius: 999px;
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  touch-action: manipulation; transition: 0.15s;
}
.cp-hotspot:hover { background: rgba(91, 138, 154, 0.42); border-color: #a9cbd6; transform: translate(-50%, -50%) scale(1.05); }
.cp-hotspot.is-on {
  background: rgba(160, 90, 90, 0.5); border-color: #e8c7c7; color: #fff;
  box-shadow: 0 0 10px rgba(255, 190, 190, 0.35);
}
.cp-hotspot.is-active { border-color: #f4f0e8; background: rgba(91, 138, 154, 0.55); }
.cp-hotspot.is-empty { opacity: 0.52; }
.cp-hotspot--sub { min-width: 3.6em; }
.cp-hotspot__t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.cp-hotspot__n {
  font-style: normal; font-size: 9px; padding: 0 3px; border-radius: 999px;
  background: rgba(255, 255, 255, 0.85); color: #8a2b2b;
}

/* ---------------- 部位操作浮层 (叠在图片上: 宽框右侧浮停 / 窄框底部抽屉) ---------------- */
.cp-detail {
  position: absolute; z-index: 40; display: flex; flex-direction: column; overflow: hidden;
  right: 8px; top: 46px; bottom: 58px; width: min(340px, 54%);
  border: 1px solid rgba(91, 138, 154, 0.38); border-radius: 12px;
  background: rgba(10, 15, 21, 0.8);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.6);
}
/* 画面框本身很窄时(手机竖屏): 改成底部抽屉, 内容单列滚动, 不会把图片挤走 */
.cp-app.is-narrow .cp-detail {
  left: 0; right: 0; top: auto; bottom: 0; width: auto; max-height: 64%;
  border-radius: 12px 12px 0 0; border-width: 1px 0 0;
}
.cp-app.is-narrow .cp-detail__scroll { padding-bottom: 58px; }
.cp-detail__head {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.cp-detail__head h3 {
  margin: 0; font-size: 15px; font-weight: 600;
  border-left: 3px solid #5b8a9a; padding-left: 8px;
}
.cp-detail__close {
  margin-left: auto; width: 28px; height: 28px; border-radius: 8px; line-height: 1;
  border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.06);
  color: #cbd8dd; font-size: 16px; cursor: pointer;
}
.cp-detail__close:hover { background: rgba(255, 120, 120, 0.22); color: #ffc0c0; }
.cp-detail__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px 14px; }
.cp-field { margin-bottom: 10px; }
.cp-field__k { display: block; font-size: 11px; color: #7fb0c0; letter-spacing: 0.04em; margin-bottom: 3px; }
.cp-field__v { margin: 0; font-size: 13px; color: #dfe8ec; word-break: break-word; }
.cp-opts__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; }
.cp-opt { min-width: 0; }
.cp-opt__btn {
  width: 100%; padding: 7px 8px; text-align: left; font-size: 12px; border-radius: 8px;
  border: 1px solid rgba(160, 90, 90, 0.42); background: rgba(120, 70, 70, 0.12);
  color: #ebe7df; cursor: pointer; transition: 0.15s; word-break: break-word;
}
.cp-opt__btn:hover { background: rgba(160, 90, 90, 0.26); }
.cp-opt__btn.is-on {
  background: rgba(180, 90, 90, 0.4); border-color: #e8e4dc;
  box-shadow: inset 0 0 8px rgba(255, 255, 255, 0.22);
}
.cp-opt__input {
  margin-top: 5px; width: 100%; padding: 5px 7px; font-size: 12px; border-radius: 6px;
  border: 1px solid rgba(173, 102, 255, 0.45); background: rgba(0, 0, 0, 0.42);
  color: #fff; outline: none; font-family: inherit;
}
.cp-opt__input:focus { border-color: #ad66ff; }
.cp-muted { font-size: 12px; color: #7a8d95; margin: 0; }

/* ---------------- 受检者档案栏 (仅并获得并排空间时出现; 竖屏收进「档案」按钮) ---------------- */
.cp-side {
  display: none;
  flex: none;
  width: 300px;
  max-width: 34%;
  max-height: 100%;
  align-self: center;
  overflow-y: auto;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: rgba(0, 0, 0, 0.28);
}
.cp-app.is-side .cp-side { display: block; }
.cp-side h4 {
  margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: #7fb0c0;
}
.cp-kv { display: flex; flex-direction: column; }
.cp-kv__row {
  display: flex; gap: 8px; justify-content: space-between; padding: 5px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.07); font-size: 12.5px;
}
.cp-kv__k { flex: none; color: #8ea6ae; }
.cp-kv__v { text-align: right; color: #e2ecef; word-break: break-word; }
.cp-side__sum { margin-top: 14px; font-size: 11.5px; color: #8ea6ae; line-height: 1.8; }
.cp-side__sum b { color: #ffd7d7; font-size: 15px; }

/* ---------------- 下边缘 tag 堆 ---------------- */
.cp-tags {
  flex: none; display: flex; flex-direction: column; gap: 5px; padding: 6px 10px 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.07); background: rgba(8, 12, 17, 0.82);
}
.cp-tags__head { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #8ea6ae; }
.cp-tags__title { color: #bfe0e8; font-weight: 600; letter-spacing: 0.05em; }
.cp-tags__count { color: #dfe8ec; font-variant-numeric: tabular-nums; }
.cp-tags__hint { flex: 1 1 auto; text-align: right; color: #6f848c; }
.cp-tags__clear {
  flex: none; padding: 2px 9px; border-radius: 999px; font-size: 11px; cursor: pointer;
  border: 1px solid rgba(255, 120, 120, 0.34); background: rgba(255, 80, 80, 0.1); color: #ffbcbc;
}
.cp-tags__list { display: flex; flex-wrap: wrap; gap: 5px; max-height: clamp(38px, 20vh, 150px); overflow-y: auto; }
.cp-tags__empty { font-size: 11.5px; color: #6f848c; }
.cp-tag {
  display: inline-flex; align-items: center; gap: 2px; max-width: 100%; cursor: pointer;
  padding: 2px 3px 2px 9px; border-radius: 999px;
  border: 1px solid rgba(91, 138, 154, 0.45); background: rgba(91, 138, 154, 0.16);
  font-size: 11.5px; color: #dce8ec;
}
.cp-tag:hover { border-color: rgba(169, 203, 214, 0.8); }
.cp-tag__text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-tag__x {
  flex: none; width: 17px; height: 17px; display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 999px; background: rgba(255, 255, 255, 0.08);
  color: #a9bcc4; font-size: 12px; line-height: 1; cursor: pointer;
}
.cp-tag__x:hover { background: rgba(255, 80, 80, 0.3); color: #ffd0d0; }

/* ---------------- 右下角常驻手册按钮 (贴在画面框右下角, 不会挡到档案栏) ---------------- */
.cp-manual {
  position: absolute; right: 10px; bottom: 10px; z-index: 60;
  width: 42px; height: 42px; border-radius: 999px;
  border: 1px solid rgba(169, 203, 214, 0.5);
  background: radial-gradient(circle at 34% 28%, rgba(120, 180, 200, 0.95), rgba(30, 60, 78, 0.95) 70%);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.35);
  font-size: 19px; line-height: 1; display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: 0.16s;
}
.cp-manual:hover { transform: scale(1.06); }
.cp-manual:active { transform: scale(0.94); }

/* ---------------- 覆盖层 (档案 / 手册) ---------------- */
.cp-sheet {
  position: absolute; inset: 0; z-index: 70;
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.cp-sheet__mask {
  position: absolute; inset: 0; background: rgba(4, 7, 10, 0.62);
  backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
}
.cp-sheet__body {
  position: relative; display: flex; flex-direction: column; overflow: hidden;
  width: min(720px, 94%); max-height: 86vh; border-radius: 16px;
  border: 1px solid rgba(169, 203, 214, 0.28); background: rgba(12, 17, 23, 0.95);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
}
.cp-sheet__head {
  flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.cp-sheet__head h3 { margin: 0; font-size: 15px; font-weight: 600; }
.cp-sheet__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 14px 16px; }
.cp-manual-tabs { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 8px; scrollbar-width: none; }
.cp-manual-tabs::-webkit-scrollbar { display: none; }
.cp-manual-tab {
  flex: none; padding: 5px 11px; border-radius: 8px; font-size: 12px; cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.1); background: rgba(255, 255, 255, 0.04); color: #96a9b1;
}
.cp-manual-tab.is-on {
  background: rgba(91, 138, 154, 0.3); border-color: rgba(127, 176, 192, 0.6); color: #f0f6f8;
}
.cp-nb { border-left: 3px solid rgba(91, 138, 154, 0.6); padding-left: 12px; margin-top: 4px; }
.cp-nb h5 { margin: 14px 0 6px; font-size: 13px; color: #cfe3ea; }
.cp-nb h5:first-child { margin-top: 0; }
.cp-nb ul { margin: 0 0 10px; padding-left: 16px; }
.cp-nb li { font-size: 12.5px; line-height: 1.75; color: #cfdae0; margin-bottom: 4px; }
.cp-nb li b { color: #ffd9a8; font-weight: 600; }
.cp-nb__note {
  margin: 0 0 10px; padding: 7px 10px; font-size: 12px; line-height: 1.7; color: #edcfa9;
  background: rgba(255, 190, 120, 0.09);
  border-left: 3px solid rgba(255, 190, 120, 0.65); border-radius: 0 6px 6px 0;
}

/* ---------------- 空状态 / 提示条 ---------------- */
/* 没有数据时: 画面框仍在 (保持 7:9 与右下角手册按钮), 里面显示提示 */
.cp-empty {
  display: none;
  position: absolute; inset: 0; z-index: 30;
  flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 18px; text-align: center; overflow: auto;
}
.cp-app.is-empty .cp-empty { display: flex; }
.cp-app.is-empty .cp-tabs,
.cp-app.is-empty .cp-hotspots { display: none; }
.cp-app.is-empty .cp-canvas { opacity: 0.3; }
.cp-app.is-empty .cp-side { display: none; }
.cp-empty h2 { margin: 0; font-size: 16px; color: #dfe8ec; }
.cp-empty p { margin: 0; font-size: 12.5px; color: #8ea6ae; max-width: 34em; line-height: 1.7; }
.cp-empty code {
  padding: 1px 5px; border-radius: 4px; background: rgba(91, 138, 154, 0.22);
  color: #cfe3ea; font-size: 12px;
}
.cp-empty .cp-ico { height: 34px; padding: 0 16px; margin-top: 4px; }
.cp-toast {
  position: fixed; left: 50%; bottom: 24%; transform: translateX(-50%);
  padding: 8px 16px; border-radius: 999px; max-width: 80%;
  background: rgba(160, 60, 60, 0.94); color: #fff; font-size: 12.5px;
  opacity: 0; pointer-events: none; transition: opacity 0.2s; z-index: 90;
}
.cp-toast.is-on { opacity: 1; }

/* ---------------- 窄屏适配 (布局本身由 JS 算, 这里只管字号与留白) ---------------- */
@media (max-width: 720px) {
  .cp-top { gap: 6px; padding: 6px 8px; }
  .cp-brand b { font-size: 13px; }
  .cp-hotspot { font-size: 10px; padding: 2px 6px; max-width: 5.4em; }
  .cp-hotspot--sub { min-width: 3.2em; }
  .cp-tabs { padding: 6px 8px; gap: 5px; }
  .cp-tab { font-size: 11px; padding: 3px 10px; }
  .cp-opts__grid { grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); }
  .cp-sheet { padding: 8px; align-items: flex-end; }
  .cp-sheet__body { width: 100%; max-height: 88vh; }
  .cp-detail__head h3 { font-size: 14px; }
  .cp-manual { width: 38px; height: 38px; font-size: 17px; right: 10px; bottom: 10px; }
}
@media (max-width: 400px) {
  .cp-brand b { display: none; }
  .cp-brand__tag { font-size: 10px; }
  .cp-ico { min-width: 28px; padding: 0 6px; }
  .cp-tags { padding: 5px 8px 6px; }
}
`;

  // ============================================================================================
  // 面板骨架
  // ============================================================================================

  const PANEL_HTML = `
<div class="cp-app">
  <header class="cp-top">
    <div class="cp-brand">
      <span class="cp-brand__dot"></span>
      <b>法医尸检报告</b>
      <span class="cp-brand__tag" data-ref="floor-tag"></span>
    </div>
    <div class="cp-chars" data-ref="chars"></div>
    <div class="cp-tools">
      <button class="cp-ico" type="button" data-act="refresh" title="重新拉取最后两层消息">↻</button>
      <button class="cp-ico" type="button" data-act="open-profile" title="受检者档案">档案</button>
      <button class="cp-ico cp-ico--danger" type="button" data-act="close" title="关闭 (Esc)">×</button>
    </div>
  </header>

  <div class="cp-body" data-ref="body">
    <div class="cp-media" data-ref="media">
      <div class="cp-frame" data-ref="frame">
        <div class="cp-canvas" data-ref="canvas"><div class="cp-vignette"></div></div>
        <div class="cp-tabs" data-ref="tabs"></div>
        <div class="cp-hotspots" data-ref="hotspots"></div>
        <div class="cp-detail" data-ref="detail" hidden></div>
        <div class="cp-empty" data-ref="empty"></div>
        <button class="cp-manual" type="button" data-act="open-manual" title="前任法医的操作笔记">📝</button>
      </div>
    </div>
    <aside class="cp-side" data-ref="side"></aside>
  </div>

  <footer class="cp-tags" data-ref="tagbar">
    <div class="cp-tags__head">
      <span class="cp-tags__title">改造指令</span>
      <span class="cp-tags__count" data-ref="tag-count">0/10</span>
      <span class="cp-tags__hint" data-ref="tag-hint"></span>
      <button class="cp-tags__clear" type="button" data-act="clear-tags">清空</button>
    </div>
    <div class="cp-tags__list" data-ref="tags"></div>
  </footer>

  <div class="cp-sheet" data-ref="sheet" hidden>
    <div class="cp-sheet__mask" data-act="close-sheet"></div>
    <div class="cp-sheet__body" data-ref="sheet-body"></div>
  </div>
</div>`;

  // ============================================================================================
  // 工具函数
  // ============================================================================================

  /** 老面板的字符串哈希 (djb2 变体), 用来给角色 id 做去重键 */
  function hashOf(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  function esc(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function attr(text) {
    return esc(text);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function scriptId() {
    try {
      return typeof getScriptId === 'function' ? getScriptId() : '';
    } catch (error) {
      return '';
    }
  }

  function devLog(...args) {
    try {
      console.info(LOG_PREFIX, ...args);
    } catch (error) {
      /* 忽略 */
    }
  }

  // ============================================================================================
  // [[corpse_data]] 解析 (逻辑取自 corpse7_debug.js)
  // ============================================================================================

  const BLOCK_RE = /\[\[corpse_data\]\]((?:(?!\[\[corpse_data\]\]|\[\[\/corpse_data\]\])[\s\S])*?)\[\[\/corpse_data\]\]/g;

  /** 老面板的严格判定: 必须出现「姓名:」或「部位状态:」且长度 > 50 */
  function isBlockValid(text) {
    return (/姓名\s*[:：]/.test(text) || /部位状态\s*[:：]/.test(text)) && text.length > 50;
  }

  /** 从原始消息文本里抽出所有合规的数据块 (纯文本, 已去掉 HTML 转义) */
  function extractCorpseBlocks(rawText) {
    const blocks = [];
    const text = String(rawText || '');
    let match;
    let index = 0;
    BLOCK_RE.lastIndex = 0;
    while ((match = BLOCK_RE.exec(text)) !== null) {
      const pure = decodeEntities(match[1]).trim();
      if (!isBlockValid(pure)) {
        continue;
      }
      index += 1;
      blocks.push({ pure, hash: hashOf(pure) + '_' + index });
    }
    return blocks;
  }

  /** 把可能存在的 HTML 实体还原成纯文本 (老面板用 jQuery 的 .text() 做同样的事) */
  function decodeEntities(html) {
    const source = String(html || '');
    if (source.indexOf('&') < 0) {
      return source;
    }
    try {
      const doc = host_doc || document;
      const node = doc.createElement('textarea');
      node.innerHTML = source;
      return node.value;
    } catch (error) {
      return source;
    }
  }

  /**
   * 解析一个数据块的正文: 档案字段 (key: value) + 部位列表 (名称: 现状 / 已改造)。
   * 逐行逻辑与老面板的 x() 完全一致。
   */
  function parseCorpseText(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const profile = {};
    const parts = [];
    let stage = 'profile';
    let current = null;

    for (const line of lines) {
      if (/^部位状态\s*[:：]?\s*$/.test(line)) {
        stage = 'parts';
        continue;
      }
      if (stage === 'profile') {
        const hit = line.match(/^([^:：]+)[:：]\s*(.*)$/);
        if (hit) {
          profile[hit[1].trim()] = hit[2].trim();
        }
        continue;
      }
      // 部位状态区
      const statusHit = line.match(/^现状\s*[:：]\s*(.*)$/);
      if (statusHit) {
        if (current) current.status = statusHit[1].trim();
        continue;
      }
      const modifiedHit = line.match(/^已改造\s*[:：]\s*(.*)$/);
      if (modifiedHit) {
        if (current) current.modified = modifiedHit[1].trim();
        continue;
      }
      const nameOnly = line.match(/^([^:：]+)\s*[:：]\s*$/);
      if (nameOnly) {
        current = { name: nameOnly[1].trim(), status: '', modified: '' };
        parts.push(current);
        continue;
      }
      const nameAndStatus = line.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
      if (nameAndStatus && nameAndStatus[1] !== '现状' && nameAndStatus[1] !== '已改造') {
        current = { name: nameAndStatus[1].trim(), status: nameAndStatus[2].trim(), modified: '' };
        parts.push(current);
      }
    }

    return { profile, parts };
  }

  // ============================================================================================
  // 最后两层消息 → 角色列表 (并集 + 去重 + 同名合并)
  // ============================================================================================

  /** 读取酒馆最后 DEPTH_FLOORS 层消息的原始文本 */
  function readLastFloors() {
    const floors = [];
    const seeded = {};

    const readOne = depth => {
      try {
        if (typeof getChatMessages !== 'function') {
          return;
        }
        const list = getChatMessages(depth);
        if (!list || !list.length) {
          return;
        }
        const message = list[0];
        if (!message || typeof message.message !== 'string') {
          return;
        }
        if (seeded[message.message_id]) {
          return;
        }
        seeded[message.message_id] = true;
        floors.push({ id: message.message_id, message: message.message });
      } catch (error) {
        console.warn(LOG_PREFIX, '读取楼层失败 (depth=' + depth + ')', error);
      }
    };

    for (let depth = DEPTH_FLOORS; depth >= 1; depth--) {
      readOne(-depth);
    }
    floors.sort((a, b) => a.id - b.id);
    return floors;
  }

  /** 把一个块合并进角色条目: 档案后楼层覆盖, 部位取并集 (同名部位后楼层优先) */
  function mergeIntoCorpse(entry, parsed, messageId) {
    Object.keys(parsed.profile).forEach(key => {
      entry.profile[key] = parsed.profile[key];
    });
    parsed.parts.forEach(part => {
      const existing = entry.parts.find(item => item.name === part.name);
      if (existing) {
        if (part.status) existing.status = part.status;
        if (part.modified) existing.modified = part.modified;
      } else {
        entry.parts.push({ name: part.name, status: part.status, modified: part.modified });
      }
    });
    if (entry.mids.indexOf(messageId) < 0) {
      entry.mids.push(messageId);
    }
    entry.last_mid = messageId;
  }

  /** 由楼层列表构建角色列表 (后楼层覆盖、部位并集、按最近楼层排序) */
  function buildCorpses(floors) {
    const list = [];
    const byName = {};

    floors.forEach(floor => {
      const blocks = extractCorpseBlocks(floor.message);
      blocks.forEach(block => {
        const parsed = parseCorpseText(block.pure);
        const name = String(parsed.profile['姓名'] || '').trim() || '未知目标';
        let entry = byName[name];
        if (!entry) {
          entry = {
            id: 'c' + hashOf(name),
            name,
            profile: {},
            parts: [],
            mids: [],
            last_mid: floor.id,
          };
          byName[name] = entry;
          list.push(entry);
        }
        mergeIntoCorpse(entry, parsed, floor.id);
      });
    });

    list.forEach(entry => {
      const age = parseInt(entry.profile['年龄'], 10);
      entry.age = Number.isFinite(age) && age > 0 ? age : 20;
      entry.bg_key = entry.age <= 16 ? '111' : entry.age <= 26 ? '222' : entry.age <= 36 ? '333' : '444';
      entry.img = lookupCharImage(entry.name);
    });

    list.sort((a, b) => b.last_mid - a.last_mid || String(a.name).localeCompare(String(b.name)));
    return list;
  }

  /** 从 localStorage 的 mvu_char_img_cache 里取角色立绘 (老面板的取法) */
  function lookupCharImage(name) {
    const stores = [];
    try {
      if (host_win && host_win.localStorage) stores.push(host_win.localStorage);
    } catch (error) {
      /* 忽略 */
    }
    try {
      stores.push(window.localStorage);
    } catch (error) {
      /* 忽略 */
    }
    for (const store of stores) {
      try {
        const raw = store.getItem('mvu_char_img_cache') || '{}';
        const map = JSON.parse(raw);
        if (map && map[name]) return String(map[name]);
      } catch (error) {
        console.warn(LOG_PREFIX, '读取 mvu_char_img_cache 失败 (只影响立绘背景)', error);
      }
    }
    return '';
  }

  // ============================================================================================
  // 状态
  // ============================================================================================

  const state = {
    /** 悬浮球位置与直径, 会写回脚本变量 */
    settings: { ball_x: null, ball_y: null, ball_size: DEFAULT_BALL_SIZE },
    ball_left: 0,
    ball_top: 0,
    /** 用户是否想看到悬浮球 (面板打开时临时隐藏) */
    ball_wanted: true,
    /** 解析出的角色列表 */
    corpses: [],
    /** 本次读取到的楼层号 */
    floor_ids: [],
    /** 当前角色 id */
    active_id: '',
    /** 已选改造项: { [charId]: { [部位]: { [选项]: true | '细则' } } } */
    selections: {},
    /** 当前视图 (main / xiaoxue / houting / koubu) */
    tab: 'main',
    /** 当前展开的部位操作浮层 */
    detail_part: '',
    /** 当前覆盖层: '' | 'profile' | 'manual' */
    sheet: '',
    /** 手册当前分页 */
    manual_tab: 0,
    /** 面板最后写到输入框的文本 (用于判断输入框是否被手动改过) */
    last_written: null,
  };

  // DOM 引用
  let host = null;
  let host_win = null;
  let host_doc = null;
  let ball_el = null;
  let style_el = null;
  let panel_el = null;
  let panel_iframe = null;
  let panel_doc = null;
  let panel_refs = null;
  let host_keydown_listener = null;
  let resize_listener = null;
  let layout_observer = null;
  let watchdog_timer = null;
  let reattach_timer = null;
  let drag = null;
  let writing = false;
  let reverse_timer = null;
  let toast_timer = null;
  let refresh_timer = null;

  // ============================================================================================
  // 起始: 找到酒馆网页本身 (脚本运行在自己的 iframe 里, 要操作的是父页面)
  // ============================================================================================

  function resolveHost() {
    try {
      const parent = window.parent;
      if (parent && parent !== window && parent.document && parent.document.body) {
        return { win: parent, doc: parent.document };
      }
    } catch (error) {
      console.warn(LOG_PREFIX, '无法访问酒馆网页 (可能被沙盒限制), 改为挂在本 iframe 内', error);
    }
    return { win: window, doc: document };
  }

  host = resolveHost();
  host_win = host.win;
  host_doc = host.doc;

  // ============================================================================================
  // 悬浮球位置设置读写 (存进本脚本自己的脚本变量, 刷新后仍在)
  // ============================================================================================

  function sanitizeSize(value) {
    const size = Number(value);
    return Number.isFinite(size) ? clamp(Math.round(size), 32, 120) : DEFAULT_BALL_SIZE;
  }

  function sanitizeCoord(value) {
    const coord = Number(value);
    return Number.isFinite(coord) ? Math.round(coord) : null;
  }

  function loadSettings() {
    if (typeof getVariables !== 'function') {
      console.warn(LOG_PREFIX, '没有 getVariables 接口, 悬浮球位置将不会记忆');
      return;
    }
    try {
      const raw = getVariables({ type: 'script' }) || {};
      state.settings.ball_x = sanitizeCoord(raw.ball_x);
      state.settings.ball_y = sanitizeCoord(raw.ball_y);
      state.settings.ball_size = sanitizeSize(raw.ball_size);
    } catch (error) {
      console.warn(LOG_PREFIX, '读取脚本变量失败, 使用默认设置', error);
    }
  }

  function saveSettings() {
    const payload = {
      ball_x: state.settings.ball_x,
      ball_y: state.settings.ball_y,
      ball_size: state.settings.ball_size,
    };
    try {
      if (typeof insertOrAssignVariables === 'function') {
        insertOrAssignVariables(payload, { type: 'script' });
        return;
      }
      if (typeof replaceVariables === 'function') {
        replaceVariables(payload, { type: 'script' });
      }
    } catch (error) {
      console.warn(LOG_PREFIX, '保存脚本变量失败', error);
    }
  }

  function ballSize() {
    return Math.round(state.settings.ball_size || DEFAULT_BALL_SIZE);
  }

  // ============================================================================================
  // 选择状态小工具
  // ============================================================================================

  function activeCorpse() {
    return state.corpses.find(item => item.id === state.active_id) || null;
  }

  function selectionsOf(charId) {
    if (!state.selections[charId]) {
      state.selections[charId] = {};
    }
    return state.selections[charId];
  }

  function countSelections(sel) {
    let total = 0;
    Object.keys(sel).forEach(part => {
      total += Object.keys(sel[part] || {}).length;
    });
    return total;
  }

  function flattenSelections(sel) {
    const out = [];
    Object.keys(sel).forEach(part => {
      const opts = sel[part] || {};
      Object.keys(opts).forEach(option => {
        const value = opts[option];
        out.push({ part, option, value: typeof value === 'string' ? value : '' });
      });
    });
    return out;
  }

  /** 部位名 → 它在数据里所属的父部位 (小穴腺体 → 小穴, …) */
  function parentOfPart(part) {
    if (SP_XIAOXUE.indexOf(part) >= 0) return '小穴';
    if (SP_HOUTING.indexOf(part) >= 0) return '后庭';
    if (SP_KOUBU.indexOf(part) >= 0) return '口部';
    return part;
  }

  /** 取某个热点对应的部位数据 (老面板的做法: 用父部位的数据 + 热点自己的名字) */
  function partDataFor(corpse, part) {
    if (!corpse) return { name: part, status: '', modified: '' };
    const parentName = parentOfPart(part);
    const found = corpse.parts.find(item => item.name === parentName) || corpse.parts.find(item => item.name === part);
    if (!found) return { name: part, status: '', modified: '' };
    return { name: part, status: found.status || '', modified: found.modified || '' };
  }

  function paneByKey(key) {
    return PANES.find(pane => pane.key === key) || PANES[0];
  }

  function tagLabel(entry) {
    return entry.part + '·' + entry.option + (entry.value ? '（' + entry.value + '）' : '');
  }

  // ============================================================================================
  // 指令文本生成 / 写入输入框 / 反向解析  (第 3 条需求的三方同步)
  // ============================================================================================

  /** 生成当前角色的改造指令 (与老面板 G() 的文本格式逐字一致) */
  function buildCommand() {
    const corpse = activeCorpse();
    if (!corpse) return '';
    const sel = state.selections[corpse.id] || {};
    const grouped = {};
    Object.keys(sel).forEach(part => {
      const options = Object.keys(sel[part] || {});
      if (!options.length) return;
      const parent = parentOfPart(part);
      if (!grouped[parent]) grouped[parent] = [];
      options.forEach(option => {
        const value = sel[part][option];
        const optionText = value === true || value === '' ? option : option + '[' + value + ']';
        grouped[parent].push(parent === part ? optionText : part + '：' + optionText);
      });
    });
    const groups = Object.keys(grouped).map(parent => '（' + parent + '）：（' + grouped[parent].join('、') + '）');
    return groups.length ? '进行' + corpse.name + CMD_MID + groups.join('；') : '';
  }

  /** 找到酒馆的真实输入框 */
  function findInput() {
    for (const selector of INPUT_SELECTORS) {
      try {
        const el = host_doc.querySelector(selector);
        if (el) return el;
      } catch (error) {
        /* 忽略 */
      }
    }
    return null;
  }

  function isInputEl(el) {
    if (!el || !el.matches) return false;
    return INPUT_SELECTORS.some(selector => {
      try {
        return el.matches(selector);
      } catch (error) {
        return false;
      }
    });
  }

  /** 把文本写进酒馆输入框 (不抢焦点, 但要触发 input/change 让酒馆的发送按钮活过来) */
  function setInputValue(el, text) {
    writing = true;
    try {
      el.value = text;
      try {
        el.dispatchEvent(new host_win.Event('input', { bubbles: true }));
        el.dispatchEvent(new host_win.Event('change', { bubbles: true }));
      } catch (error) {
        /* 忽略 */
      }
      try {
        if (typeof host_win.$ === 'function') {
          host_win.$(el).trigger('input').trigger('change');
        }
      } catch (error) {
        /* 忽略 */
      }
      try {
        el.selectionStart = text.length;
        el.selectionEnd = text.length;
      } catch (error) {
        /* 忽略 */
      }
    } finally {
      writing = false;
    }
  }

  /** 把指令同步到输入框; 返回是否成功 */
  function writeCommand() {
    const text = buildCommand();
    const el = findInput();
    if (!el) {
      setTagHint('未找到酒馆输入框');
      return false;
    }
    const current = String(el.value || '');
    if (current === text) {
      state.last_written = text;
      setTagHint(text ? '已同步到输入框' : '');
      return true;
    }
    // 没有任何已选项时, 只有当输入框里仍是面板上次写的指令才清空, 避免删掉玩家自己打的字
    if (!text && state.last_written !== current) {
      setTagHint('输入框有手写内容, 未覆盖');
      return false;
    }
    setInputValue(el, text);
    state.last_written = text;
    setTagHint(text ? '已同步到输入框' : '已清空输入框');
    return true;
  }

  const HEAD_RE = /^\s*进行(.+?)的改造\+同时把玩的剧情，改造指令：([\s\S]*)$/;

  /** 尽力反向解析面板自己生成的指令格式; 解析不出来返回 null */
  function parseCommandText(text) {
    const match = HEAD_RE.exec(String(text || ''));
    if (!match) return null;
    const name = match[1].trim();
    const body = match[2];
    const items = [];
    const groupRe = /（([^（）]+)）：（([^（）]*)）/g;
    let group;
    while ((group = groupRe.exec(body)) !== null) {
      const parent = group[1].trim();
      group[2]
        .split('、')
        .map(piece => piece.trim())
        .filter(piece => piece.length > 0)
        .forEach(piece => {
          let part = parent;
          let rest = piece;
          const colonAt = piece.indexOf('：');
          if (colonAt > 0) {
            part = piece.slice(0, colonAt).trim();
            rest = piece.slice(colonAt + 1).trim();
          }
          let option = rest;
          let value = '';
          const bracket = /^(.+?)\[([\s\S]*)\]$/.exec(rest);
          if (bracket) {
            option = bracket[1].trim();
            value = bracket[2];
          }
          if (option) items.push({ part, option, value });
        });
    }
    if (!items.length) return null;
    return { name, items };
  }

  /** 把反向解析结果套到对应角色身上 (只接受本面板已知的部位与选项) */
  function applyParsedCommand(parsed) {
    const corpse = state.corpses.find(item => item.name === parsed.name);
    if (!corpse) return null;
    const next = {};
    parsed.items.forEach(item => {
      const known = OPTIONS[item.part];
      if (!known || known.indexOf(item.option) < 0) return;
      if (!next[item.part]) next[item.part] = {};
      next[item.part][item.option] = item.value ? item.value : true;
    });
    state.selections[corpse.id] = next;
    return corpse;
  }

  /** 输入框被手动改动后的反向同步 (防抖 260ms) */
  function scheduleReverseSync() {
    if (reverse_timer) clearTimeout(reverse_timer);
    reverse_timer = setTimeout(() => {
      reverse_timer = null;
      const el = findInput();
      if (!el) return;
      const text = String(el.value || '');
      if (state.last_written !== null && text === state.last_written) return;

      const corpse = activeCorpse();
      if (!text.trim()) {
        if (corpse && state.selections[corpse.id] && Object.keys(state.selections[corpse.id]).length) {
          state.selections[corpse.id] = {};
          state.last_written = null;
          if (panel_doc) {
            renderTagbar();
            syncOptionStates();
            refreshHotspots();
            updateSideCount();
          }
        }
        return;
      }

      const parsed = parseCommandText(text);
      if (!parsed) return;
      const target = applyParsedCommand(parsed);
      if (!target) return;
      state.last_written = null;
      if (!panel_doc) return;
      const switched = target.id !== state.active_id;
      state.active_id = target.id;
      if (switched) {
        renderChars();
        renderMedia();
      }
      renderTagbar();
      syncOptionStates();
      refreshHotspots();
      updateSideCount();
    }, 260);
  }

  // ============================================================================================
  // 数据加载
  // ============================================================================================

  function loadData(options) {
    const opts = options || {};
    const floors = readLastFloors();
    state.floor_ids = floors.map(floor => floor.id);

    const corpses = buildCorpses(floors);
    state.corpses = corpses;

    // 清理已经不存在的角色的选择
    const alive = {};
    corpses.forEach(corpse => {
      alive[corpse.id] = true;
    });
    Object.keys(state.selections).forEach(id => {
      if (!alive[id]) delete state.selections[id];
    });
    if (!corpses.some(corpse => corpse.id === state.active_id)) {
      state.active_id = corpses.length ? corpses[0].id : '';
    }

    if (opts.render !== false) afterDataLoaded();

    // 事件触发得早时消息可能还没写完, 给一次短重试
    if (!corpses.length && !opts.no_retry) {
      if (refresh_timer) clearTimeout(refresh_timer);
      refresh_timer = setTimeout(() => {
        refresh_timer = null;
        loadData({ no_retry: true });
      }, 420);
    }

    return corpses;
  }

  function afterDataLoaded() {
    if (!panel_doc) return;
    renderChars();
    renderMedia();
    renderTagbar();
    layoutFrame();
  }

  // ============================================================================================
  // 面板渲染: 顶边栏角色胶囊
  // ============================================================================================

  function setText(refName, text) {
    const node = panel_refs && panel_refs[refName];
    if (node) node.textContent = text;
  }

  function setTagHint(text) {
    setText('tag-hint', text || '');
  }

  function floorTagText() {
    const ids = state.floor_ids;
    if (!ids.length) return '';
    if (ids.length === 1) return '楼 ' + ids[0];
    return '楼 ' + ids[0] + '–' + ids[ids.length - 1];
  }

  function renderChars() {
    const box = panel_refs && panel_refs.chars;
    if (!box) return;
    if (!state.corpses.length) {
      box.innerHTML = '<span class="cp-chars__empty">未识别到 corpse_data</span>';
    } else {
      box.innerHTML = state.corpses
        .map(corpse => {
          const active = corpse.id === state.active_id ? ' is-on' : '';
          const selected = countSelections(state.selections[corpse.id] || {});
          const age = corpse.profile['年龄'] ? String(corpse.profile['年龄']) : '';
          return (
            '<button type="button" class="cp-char' +
            active +
            '" data-act="select-char" data-id="' +
            attr(corpse.id) +
            '"><b>' +
            esc(corpse.name) +
            '</b><small>' +
            esc(age) +
            (selected ? ' · 已选' + selected : '') +
            '</small></button>'
          );
        })
        .join('');
    }
    setText('floor-tag', floorTagText());
  }

  // ============================================================================================
  // 面板渲染: 主舞台 (图片 + 视图标签 + 部位按钮 + 操作浮层 + 档案栏)
  // ============================================================================================

  function canvasStyle(corpse, pane) {
    if (pane.bg_index < 0) {
      if (corpse.img) {
        return 'background-image:url(\'' + corpse.img.replace(/'/g, '%27') + '\');';
      }
      return 'background:linear-gradient(160deg,#1e2836 0%,#0c1016 100%);';
    }
    const group = LOCAL_BG[corpse.bg_key] || LOCAL_BG['222'];
    const url = group[pane.bg_index] || group[0];
    return 'background-image:url(\'' + url + '\');background-color:#06080d;';
  }

  function buildTabsHtml() {
    return PANES.map(pane => {
      const active = pane.key === state.tab ? ' is-on' : '';
      return (
        '<button type="button" class="cp-tab' +
        active +
        '" data-act="select-tab" data-key="' +
        pane.key +
        '">' +
        pane.label +
        '</button>'
      );
    }).join('');
  }

  function buildHotspotsHtml(parts) {
    const corpse = activeCorpse();
    const sel = corpse ? state.selections[corpse.id] || {} : {};
    return parts
      .filter(name => HOTSPOT_COORDS[name])
      .map(name => {
        const coord = HOTSPOT_COORDS[name];
        const data = partDataFor(corpse, name);
        const count = Object.keys(sel[name] || {}).length;
        const cls = ['cp-hotspot'];
        if (parts !== PART_MAIN) cls.push('cp-hotspot--sub');
        if (!data.status && !data.modified) cls.push('is-empty');
        if (count) cls.push('is-on');
        return (
          '<button type="button" class="' +
          cls.join(' ') +
          '" style="left:' +
          coord.left +
          ';top:' +
          coord.top +
          '" data-act="open-part" data-part="' +
          attr(name) +
          '" title="' +
          attr(name) +
          '"><span class="cp-hotspot__t">' +
          esc(name) +
          '</span>' +
          (count ? '<i class="cp-hotspot__n">' + count + '</i>' : '') +
          '</button>'
        );
      })
      .join('');
  }

  function profileRows(corpse) {
    const rows = [];
    if (corpse.profile['姓名']) rows.push({ k: '姓名', v: corpse.profile['姓名'] });
    PROFILE_KEYS.forEach(key => {
      const value = corpse.profile[key];
      if (value !== undefined && value !== null && value !== '') rows.push({ k: key, v: String(value) });
    });
    Object.keys(corpse.profile).forEach(key => {
      if (key === '姓名' || PROFILE_KEYS.indexOf(key) >= 0) return;
      const value = corpse.profile[key];
      if (value !== undefined && value !== null && value !== '') rows.push({ k: key, v: String(value) });
    });
    return rows;
  }

  /** 档案栏内部内容 (外层 .cp-side 是固定的, 只换内容, 免得重建影响布局观察) */
  function buildSideInner(corpse) {
    const rows = profileRows(corpse);
    const total = countSelections(state.selections[corpse.id] || {});
    return (
      '<h4>受检者信息</h4>' +
      '<div class="cp-kv">' +
      rows
        .map(
          row =>
            '<div class="cp-kv__row"><span class="cp-kv__k">' +
            esc(row.k) +
            '</span><span class="cp-kv__v">' +
            esc(row.v) +
            '</span></div>',
        )
        .join('') +
      '</div>' +
      '<h4 style="margin-top:16px">本次改造</h4>' +
      '<div class="cp-side__sum"><b data-ref="side-count">' +
      total +
      '</b> / ' +
      MAX_SELECT +
      ' 项<br />来源楼层 ' +
      esc(corpse.mids.join('、')) +
      '<br />部位 ' +
      corpse.parts.length +
      ' 个</div>'
    );
  }

  function buildEmptyHtml() {
    const floorText = floorTagText();
    const tips = state.corpses.length
      ? '<p>当前没有任何角色数据, 点下面的按钮重新拉取。</p>'
      : '<p>只认「酒馆最后 ' +
        DEPTH_FLOORS +
        ' 层消息」里的 <code>[[corpse_data]]</code>…<code>[[/corpse_data]]</code> 标签。<br />' +
        (floorText ? '已读取 ' + floorText + '。' : '还没读到任何楼层。') +
        ' 标签内容需要同时包含「姓名:」与「部位状态:」两段, 且长度大于 50 字。</p>';
    return (
      '<h2>没有可用的尸检数据</h2>' +
      tips +
      '<button class="cp-ico" type="button" data-act="refresh">重新拉取最后两层</button>'
    );
  }

  // ============================================================================================
  // 主区域布局: 7:9 画面框内切于可用空间, 档案栏有位置才并排, 全都居中
  // ============================================================================================

  function appEl() {
    return panel_doc ? panel_doc.querySelector('.cp-app') : null;
  }

  /** 在给定可用区域内求出 7:9 的内切尺寸 */
  function solveFrame(avail_w, avail_h) {
    let w = Math.min(avail_w, avail_h * FRAME_RATIO);
    let h = w / FRAME_RATIO;
    if (h > avail_h) {
      h = avail_h;
      w = h * FRAME_RATIO;
    }
    w = Math.max(48, Math.floor(w));
    h = Math.max(60, Math.floor(w / FRAME_RATIO));
    return { w, h };
  }

  function layoutFrame() {
    if (!panel_doc || !panel_refs) return;
    const app = appEl();
    const body = panel_refs.body;
    if (!app || !body) return;

    const body_w = body.clientWidth;
    const body_h = body.clientHeight;
    if (body_w < 2 || body_h < 2) return;

    const pad = BODY_PADDING;
    const avail_h = Math.max(48, body_h - pad * 2);
    const inner_w = Math.max(48, body_w - pad * 2);

    // 1) 先按「并排」算一次: 空间够大才让档案栏常驻
    const candidate_side = Math.min(SIDE_WIDTH, inner_w * 0.34);
    let want_side = body_w >= SIDE_BREAKPOINT;
    let side_w = want_side ? candidate_side : 0;
    let frame = solveFrame(Math.max(48, inner_w - side_w - (side_w ? SIDE_GAP : 0)), avail_h);

    // 2) 图片被挤得太小就让档案栏让位 (横屏手机这种很矮的可用区域)
    if (want_side && frame.w < SIDE_MIN_FRAME) {
      want_side = false;
      side_w = 0;
      frame = solveFrame(inner_w, avail_h);
    }

    app.classList.toggle('is-side', want_side);
    app.classList.toggle('is-narrow', frame.w < NARROW_FRAME_WIDTH);

    const side = panel_refs.side;
    if (side) side.style.width = side_w ? Math.round(side_w) + 'px' : '';

    const frameEl = panel_refs.frame;
    if (frameEl) {
      frameEl.style.width = frame.w + 'px';
      frameEl.style.height = frame.h + 'px';
    }
  }

  /** 渲染主画面 (只改画面框内部, 保持画面框元素与尺寸策略稳定) */
  function renderMedia() {
    if (!panel_doc || !panel_refs) return;
    const app = appEl();
    const corpse = activeCorpse();

    if (app) app.classList.toggle('is-empty', !corpse);
    renderEmpty();

    if (!corpse) {
      state.detail_part = '';
      renderDetail();
      renderSide();
      // 空状态下画面框仍要保持 7:9 尺寸, 提示文字才在框里居中显示
      layoutFrame();
      return;
    }

    const pane = paneByKey(state.tab);
    if (panel_refs.canvas) panel_refs.canvas.setAttribute('style', canvasStyle(corpse, pane));
    if (panel_refs.tabs) panel_refs.tabs.innerHTML = buildTabsHtml();
    refreshHotspots();
    renderDetail();
    renderSide();
    layoutFrame();
  }

  function renderSide() {
    const corpse = activeCorpse();
    if (!panel_refs || !panel_refs.side) return;
    if (!corpse) {
      panel_refs.side.innerHTML = '';
      return;
    }
    panel_refs.side.innerHTML = buildSideInner(corpse);
    collectRefs();
  }

  function renderEmpty() {
    if (!panel_refs || !panel_refs.empty) return;
    const corpse = activeCorpse();
    if (corpse) {
      panel_refs.empty.innerHTML = '';
      return;
    }
    panel_refs.empty.innerHTML = buildEmptyHtml();
  }

  function collectRefs() {
    if (!panel_doc) return;
    panel_refs = {};
    panel_doc.querySelectorAll('[data-ref]').forEach(node => {
      const name = node.getAttribute('data-ref');
      if (!panel_refs[name]) panel_refs[name] = node;
    });
  }

  // ============================================================================================
  // 面板渲染: 部位操作浮层
  // ============================================================================================

  function buildOptionsHtml(part) {
    const corpse = activeCorpse();
    const sel = corpse ? state.selections[corpse.id] || {} : {};
    const partSel = sel[part] || {};
    const options = OPTIONS[part] || [];
    if (!options.length) {
      return '<p class="cp-muted">（该部位暂无预设改造项）</p>';
    }
    return options
      .map(option => {
        const chosen = partSel[option] !== undefined;
        const value = typeof partSel[option] === 'string' ? partSel[option] : '';
        const custom = CUSTOM_OPTIONS.indexOf(option) >= 0;
        return (
          '<div class="cp-opt">' +
          '<button type="button" class="cp-opt__btn' +
          (chosen ? ' is-on' : '') +
          '" data-act="toggle-option" data-part="' +
          attr(part) +
          '" data-option="' +
          attr(option) +
          '">' +
          esc(option) +
          '</button>' +
          (custom
            ? '<input type="text" class="cp-opt__input" data-role="option-value" data-part="' +
              attr(part) +
              '" data-option="' +
              attr(option) +
              '" placeholder="附加细则…" value="' +
              attr(value) +
              '"' +
              (chosen ? '' : ' hidden') +
              '>'
            : '') +
          '</div>'
        );
      })
      .join('');
  }

  function renderDetail() {
    const box = panel_refs && panel_refs.detail;
    if (!box) return;
    const corpse = activeCorpse();
    const part = state.detail_part;
    if (!corpse || !part) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const data = partDataFor(corpse, part);
    box.hidden = false;
    box.innerHTML =
      '<div class="cp-detail__head">' +
      '<h3>' +
      esc(part) +
      '</h3>' +
      '<button class="cp-detail__close" type="button" data-act="close-detail" title="收起">×</button>' +
      '</div>' +
      '<div class="cp-detail__scroll">' +
      '<div class="cp-field"><span class="cp-field__k">现状</span><p class="cp-field__v">' +
      esc(data.status || '—') +
      '</p></div>' +
      '<div class="cp-field"><span class="cp-field__k">已改造</span><p class="cp-field__v">' +
      esc(data.modified || '—') +
      '</p></div>' +
      '<div class="cp-field"><span class="cp-field__k">改造选项</span><div class="cp-opts__grid">' +
      buildOptionsHtml(part) +
      '</div></div>' +
      '</div>';
    markActiveHotspot(part);
  }

  /** 把当前展开的部位对应的按钮高亮 */
  function markActiveHotspot(part) {
    if (!panel_refs || !panel_refs.hotspots) return;
    panel_refs.hotspots.querySelectorAll('.cp-hotspot').forEach(btn => {
      btn.classList.toggle('is-active', Boolean(part) && btn.getAttribute('data-part') === part);
    });
  }

  /** 某个部位属于哪个视图 */
  function paneKeyForPart(part) {
    for (const pane of PANES) {
      if (pane.parts.indexOf(part) >= 0) return pane.key;
    }
    return 'main';
  }

  /** 只同步选中态, 不重建 DOM (避免细则输入框失焦) */
  function syncOptionStates() {
    if (!panel_doc) return;
    const corpse = activeCorpse();
    const part = state.detail_part;
    if (!corpse || !part) return;
    const sel = (state.selections[corpse.id] || {})[part] || {};
    panel_doc.querySelectorAll('.cp-opt__btn').forEach(btn => {
      const option = btn.getAttribute('data-option');
      btn.classList.toggle('is-on', sel[option] !== undefined);
    });
    panel_doc.querySelectorAll('[data-role="option-value"]').forEach(input => {
      const option = input.getAttribute('data-option');
      const chosen = sel[option] !== undefined;
      input.hidden = !chosen;
      if (panel_doc.activeElement !== input) {
        input.value = chosen && typeof sel[option] === 'string' ? sel[option] : '';
      }
    });
  }

  /** 刷新部位按钮上的已选数量标记 */
  function refreshHotspots() {
    if (!panel_doc || !panel_refs || !panel_refs.hotspots) return;
    const pane = paneByKey(state.tab);
    panel_refs.hotspots.innerHTML = buildHotspotsHtml(pane.parts);
    markActiveHotspot(state.detail_part);
  }

  function updateSideCount() {
    const corpse = activeCorpse();
    const node = panel_refs && panel_refs['side-count'];
    if (!corpse || !node) return;
    node.textContent = String(countSelections(state.selections[corpse.id] || {}));
  }

  // ============================================================================================
  // 面板渲染: 下边缘 tag 堆
  // ============================================================================================

  function renderTagbar() {
    const list = panel_refs && panel_refs.tags;
    if (!list) return;
    const corpse = activeCorpse();
    const sel = corpse ? state.selections[corpse.id] || {} : {};
    const entries = flattenSelections(sel);
    if (!entries.length) {
      list.innerHTML = '<span class="cp-tags__empty">还没有选择改造项 —— 点图片上的部位按钮开始</span>';
    } else {
      list.innerHTML = entries
        .map(entry => {
          return (
            '<span class="cp-tag" data-act="jump-part" data-part="' +
            attr(entry.part) +
            '" title="点一下跳到该部位"><span class="cp-tag__text">' +
            esc(tagLabel(entry)) +
            '</span><button class="cp-tag__x" type="button" data-act="remove-tag" data-part="' +
            attr(entry.part) +
            '" data-option="' +
            attr(entry.option) +
            '" title="删除该改造">×</button></span>'
          );
        })
        .join('');
    }
    setText('tag-count', entries.length + '/' + MAX_SELECT);
    layoutFrame();
  }

  // ============================================================================================
  // 面板渲染: 覆盖层 (档案 / 手册)
  // ============================================================================================

  function renderSheet() {
    const sheet = panel_refs && panel_refs.sheet;
    const body = panel_refs && panel_refs['sheet-body'];
    if (!sheet || !body) return;
    if (!state.sheet) {
      sheet.hidden = true;
      body.innerHTML = '';
      return;
    }
    sheet.hidden = false;

    if (state.sheet === 'profile') {
      const corpse = activeCorpse();
      const rows = corpse ? profileRows(corpse) : [];
      body.innerHTML =
        '<div class="cp-sheet__head"><h3>受检者档案' +
        (corpse ? ' · ' + esc(corpse.name) : '') +
        '</h3><button class="cp-ico cp-ico--danger" type="button" data-act="close-sheet" title="关闭">×</button></div>' +
        '<div class="cp-sheet__scroll"><div class="cp-kv">' +
        (rows.length
          ? rows
              .map(
                row =>
                  '<div class="cp-kv__row"><span class="cp-kv__k">' +
                  esc(row.k) +
                  '</span><span class="cp-kv__v">' +
                  esc(row.v) +
                  '</span></div>',
              )
              .join('')
          : '<p class="cp-muted">没有解析到受检者档案字段。</p>') +
        '</div>' +
        (corpse
          ? '<p class="cp-muted" style="margin-top:12px">来源楼层 ' +
            esc(corpse.mids.join('、')) +
            ' · 部位 ' +
            corpse.parts.length +
            ' 个</p>'
          : '') +
        '</div>';
      return;
    }

    // 手册
    const page = MANUAL_PAGES[state.manual_tab] || MANUAL_PAGES[0];
    body.innerHTML =
      '<div class="cp-sheet__head"><h3>📝 前任法医的操作笔记</h3>' +
      '<button class="cp-ico cp-ico--danger" type="button" data-act="close-sheet" title="关闭">×</button></div>' +
      '<div class="cp-sheet__scroll"><div class="cp-manual-tabs">' +
      MANUAL_PAGES.map((item, index) => {
        return (
          '<button type="button" class="cp-manual-tab' +
          (index === state.manual_tab ? ' is-on' : '') +
          '" data-act="manual-tab" data-index="' +
          index +
          '">' +
          esc(item.label) +
          '</button>'
        );
      }).join('') +
      '</div><div class="cp-nb">' +
      page.blocks
        .map(block => {
          if (block.type === 'note') {
            return '<p class="cp-nb__note">' + esc(block.text) + '</p>';
          }
          return (
            '<h5>' +
            esc(block.title) +
            '</h5><ul>' +
            block.items
              .map(item => '<li><b>' + esc(item.k) + '</b>' + esc(item.v) + '</li>')
              .join('') +
            '</ul>'
          );
        })
        .join('') +
      '</div></div>';
  }

  // ============================================================================================
  // 面板提示条
  // ============================================================================================

  function showToast(text) {
    if (!panel_doc) return;
    let toast = panel_doc.querySelector('.cp-toast');
    if (!toast) {
      toast = panel_doc.createElement('div');
      toast.className = 'cp-toast';
      panel_doc.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('is-on');
    if (toast_timer) clearTimeout(toast_timer);
    toast_timer = setTimeout(() => {
      toast_timer = null;
      if (toast && toast.parentNode) toast.classList.remove('is-on');
    }, 2000);
  }

  // ============================================================================================
  // 选择变更 (选项 / tag / 细则) —— 所有变更都走这里, 保证三方同步
  // ============================================================================================

  function afterSelectionChange() {
    writeCommand();
    renderTagbar();
    syncOptionStates();
    refreshHotspots();
    updateSideCount();
    renderChars();
  }

  function toggleOption(part, option) {
    const corpse = activeCorpse();
    if (!corpse) return;
    const sel = selectionsOf(corpse.id);
    const partSel = sel[part] || {};

    if (partSel[option] !== undefined) {
      delete partSel[option];
      if (!Object.keys(partSel).length) delete sel[part];
      // 取消选中时清空它自己的细则输入框 (老面板的行为)
      if (panel_doc) {
        panel_doc.querySelectorAll('[data-role="option-value"]').forEach(input => {
          if (input.getAttribute('data-option') === option) input.value = '';
        });
      }
    } else {
      const total = countSelections(sel);
      if (total >= MAX_SELECT) {
        showToast('一次少改点，分部位和步骤来，剧情写不过来了喵！(上限 ' + MAX_SELECT + ' 项)');
        return;
      }
      if (!sel[part]) sel[part] = {};
      sel[part][option] = true;
    }
    afterSelectionChange();
  }

  function setOptionValue(part, option, value) {
    const corpse = activeCorpse();
    if (!corpse) return;
    const sel = state.selections[corpse.id];
    if (!sel || !sel[part] || sel[part][option] === undefined) return;
    sel[part][option] = value || '';
    writeCommand();
    renderTagbar();
  }

  function removeTag(part, option) {
    const corpse = activeCorpse();
    if (!corpse) return;
    const sel = state.selections[corpse.id];
    if (!sel || !sel[part]) return;
    delete sel[part][option];
    if (!Object.keys(sel[part]).length) delete sel[part];
    afterSelectionChange();
  }

  function clearTags() {
    const corpse = activeCorpse();
    if (!corpse) return;
    state.selections[corpse.id] = {};
    afterSelectionChange();
  }

  // ============================================================================================
  // 面板交互 (事件委托画在 panel_doc 上)
  // ============================================================================================

  function selectChar(id) {
    if (!id || id === state.active_id) return;
    if (!state.corpses.some(corpse => corpse.id === id)) return;
    state.active_id = id;
    state.detail_part = '';
    renderChars();
    renderMedia();
    renderTagbar();
    // 切换角色 → 输入框与 tag 堆一起切到该角色的指令
    writeCommand();
  }

  function selectTab(key) {
    if (state.tab === key) return;
    state.tab = key;
    state.detail_part = '';
    const tabs = panel_refs && panel_refs.tabs;
    if (tabs) {
      tabs.innerHTML = buildTabsHtml();
    }
    const canvas = panel_refs && panel_refs.canvas;
    const corpse = activeCorpse();
    if (canvas && corpse) {
      canvas.setAttribute('style', canvasStyle(corpse, paneByKey(key)));
    }
    refreshHotspots();
    renderDetail();
  }

  function openPart(part) {
    state.detail_part = part;
    renderDetail();
    syncOptionStates();
    const scroll = panel_refs && panel_refs.detail && panel_refs.detail.querySelector('.cp-detail__scroll');
    if (scroll) scroll.scrollTop = 0;
  }

  /** 点击 tag: 跳到它所属的视图并展开该部位 */
  function revealPart(part) {
    const key = paneKeyForPart(part);
    if (key !== state.tab) selectTab(key);
    openPart(part);
  }

  function closePart() {
    state.detail_part = '';
    renderDetail();
  }

  function openSheet(kind) {
    state.sheet = kind;
    renderSheet();
  }

  function closeSheet() {
    state.sheet = '';
    renderSheet();
  }

  function onPanelClick(event) {
    const el = event.target && event.target.closest ? event.target.closest('[data-act]') : null;
    if (!el) return;
    const act = el.getAttribute('data-act');
    switch (act) {
      case 'close':
        closePanel();
        break;
      case 'refresh':
        refreshData();
        break;
      case 'select-char':
        selectChar(el.getAttribute('data-id'));
        break;
      case 'select-tab':
        selectTab(el.getAttribute('data-key'));
        break;
      case 'open-part':
        openPart(el.getAttribute('data-part'));
        break;
      case 'close-detail':
        closePart();
        break;
      case 'toggle-option':
        toggleOption(el.getAttribute('data-part'), el.getAttribute('data-option'));
        break;
      case 'remove-tag':
        removeTag(el.getAttribute('data-part'), el.getAttribute('data-option'));
        break;
      case 'jump-part':
        revealPart(el.getAttribute('data-part'));
        break;
      case 'clear-tags':
        clearTags();
        break;
      case 'open-profile':
        openSheet('profile');
        break;
      case 'open-manual':
        openSheet('manual');
        break;
      case 'close-sheet':
        closeSheet();
        break;
      case 'manual-tab':
        state.manual_tab = Number(el.getAttribute('data-index')) || 0;
        renderSheet();
        break;
      default:
        break;
    }
  }

  function onPanelInput(event) {
    const target = event.target;
    if (!target || target.getAttribute('data-role') !== 'option-value') return;
    setOptionValue(target.getAttribute('data-part'), target.getAttribute('data-option'), target.value);
  }

  function onPanelKeydown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (state.sheet) {
      closeSheet();
      return;
    }
    if (state.detail_part) {
      closePart();
      return;
    }
    closePanel();
  }

  function refreshData() {
    loadData();
    if (panel_doc && !state.corpses.length) {
      showToast('最后两层里没有找到 [[corpse_data]] 数据');
    }
  }

  // ============================================================================================
  // 全屏面板: 开关与挂载
  // ============================================================================================

  function buildPanelSrcdoc() {
    return (
      '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<style>' +
      PANEL_CSS +
      '</style></head><body></body></html>'
    );
  }

  function openPanel() {
    if (panel_el) {
      devLog('全屏面板已经打开, 忽略重复点击');
      return;
    }

    loadData({ render: false });
    state.sheet = '';
    state.detail_part = '';

    panel_el = host_doc.createElement('div');
    panel_el.className = 'cpb-panel';
    panel_el.setAttribute(MARK, 'panel');
    panel_el.setAttribute('script_id', scriptId());

    panel_iframe = host_doc.createElement('iframe');
    panel_iframe.className = 'cpb-panel__iframe';
    panel_iframe.setAttribute(MARK, 'panel-iframe');
    panel_iframe.setAttribute('title', '法医尸检报告 · 全屏面板');
    panel_iframe.setAttribute('allow', 'fullscreen');
    panel_iframe.setAttribute('allowfullscreen', 'true');
    panel_iframe.setAttribute('frameborder', '0');
    panel_iframe.srcdoc = buildPanelSrcdoc();
    panel_iframe.addEventListener('load', mountPanelApp);

    panel_el.appendChild(panel_iframe);
    host_doc.body.appendChild(panel_el);

    if (!host_keydown_listener) {
      host_keydown_listener = event => {
        if (event.key === 'Escape') closePanel();
      };
      host_doc.addEventListener('keydown', host_keydown_listener);
    }

    updateBallVisibility();
    devLog('已打开全屏面板');
  }

  function mountPanelApp() {
    panel_doc = panel_iframe ? panel_iframe.contentDocument : null;
    if (!panel_doc) {
      console.error(LOG_PREFIX, '无法访问面板 iframe 的 document');
      return;
    }

    // 允许被自愈巡检重复调用: 先拆掉上一次挂上的监听/DOM
    teardownPanelApp();

    panel_doc.body.innerHTML = PANEL_HTML;
    try {
      panel_iframe.contentWindow.focus();
    } catch (error) {
      /* 忽略 */
    }
    collectRefs();

    // 从输入框恢复上次的选择 (尽力反向解析)
    adoptFromInput();

    renderChars();
    renderMedia();
    renderSide();
    renderTagbar();
    renderSheet();
    layoutFrame();

    panel_doc.addEventListener('click', onPanelClick);
    panel_doc.addEventListener('input', onPanelInput);
    panel_doc.addEventListener('keydown', onPanelKeydown);

    // 备用: 窗口尺寸变化时重算画面框 (ResizeObserver 不可用时也能工作)
    resize_listener = () => {
      layoutFrame();
    };
    try {
      panel_doc.defaultView.addEventListener('resize', resize_listener);
    } catch (error) {
      /* 忽略 */
    }

    // 首选: 观察主区域与 tag 条的真实尺寸变化 (含 tag 条换行、字体加载等)
    setupLayoutObserver();

    devLog('全屏面板已挂载');
  }

  /** 观察主区域与 tag 条的尺寸变化, 实时重算画面框 */
  function setupLayoutObserver() {
    if (!panel_doc || typeof panel_doc.defaultView.ResizeObserver !== 'function') return;
    const ViewResizeObserver = panel_doc.defaultView.ResizeObserver;
    layout_observer = new ViewResizeObserver(() => {
      layoutFrame();
    });
    [panel_refs.body, panel_refs.tagbar].forEach(node => {
      if (node) {
        try {
          layout_observer.observe(node);
        } catch (error) {
          /* 忽略 */
        }
      }
    });
  }

  function teardownLayoutObserver() {
    if (layout_observer) {
      try {
        layout_observer.disconnect();
      } catch (error) {
        /* 忽略 */
      }
      layout_observer = null;
    }
    if (resize_listener) {
      try {
        if (panel_doc && panel_doc.defaultView) {
          panel_doc.defaultView.removeEventListener('resize', resize_listener);
        }
      } catch (error) {
        /* 忽略 */
      }
      resize_listener = null;
    }
  }

  /** 拆掉挂在面板文档上的所有东西 (自愈重挂载时先做这一步) */
  function teardownPanelApp() {
    teardownLayoutObserver();
    if (!panel_doc) return;
    try {
      panel_doc.removeEventListener('click', onPanelClick);
      panel_doc.removeEventListener('input', onPanelInput);
      panel_doc.removeEventListener('keydown', onPanelKeydown);
    } catch (error) {
      /* 忽略 */
    }
    panel_refs = null;
  }

  /** 打开面板/切换角色时, 让 tag 堆从输入框里把上次的选择读回来 */
  function adoptFromInput() {
    const el = findInput();
    if (!el) return;
    const text = String(el.value || '');
    if (!text.trim()) return;
    const parsed = parseCommandText(text);
    if (!parsed) return;
    const corpse = applyParsedCommand(parsed);
    if (!corpse) return;
    state.active_id = corpse.id;
    state.last_written = text;
  }

  function closePanel() {
    if (!panel_el) return;
    const closing = panel_el;

    // 先拆监听/观察器, 再摘引用
    teardownLayoutObserver();
    if (panel_doc) {
      try {
        panel_doc.removeEventListener('click', onPanelClick);
        panel_doc.removeEventListener('input', onPanelInput);
        panel_doc.removeEventListener('keydown', onPanelKeydown);
      } catch (error) {
        /* 忽略 */
      }
    }

    panel_el = null;
    panel_iframe = null;
    panel_doc = null;
    panel_refs = null;
    if (toast_timer) {
      clearTimeout(toast_timer);
      toast_timer = null;
    }

    if (host_keydown_listener) {
      host_doc.removeEventListener('keydown', host_keydown_listener);
      host_keydown_listener = null;
    }

    updateBallVisibility();
    closing.classList.add('cpb-panel--closing');
    host_win.setTimeout(() => {
      if (closing.parentNode) closing.parentNode.removeChild(closing);
    }, PANEL_FADE_MS + 40);
    devLog('已关闭全屏面板');
  }

  // ============================================================================================
  // 悬浮球
  // ============================================================================================

  function setBallPosition(left, top, save) {
    const size = ballSize();
    const view = viewportSize();
    state.ball_left = clamp(left, EDGE_PADDING, view.w - size - EDGE_PADDING);
    state.ball_top = clamp(top, EDGE_PADDING, view.h - size - EDGE_PADDING);
    if (ball_el) {
      ball_el.style.left = state.ball_left + 'px';
      ball_el.style.top = state.ball_top + 'px';
    }
    if (save) {
      state.settings.ball_x = Math.round(state.ball_left);
      state.settings.ball_y = Math.round(state.ball_top);
      saveSettings();
    }
  }

  function viewportSize() {
    const root = host_doc.documentElement || {};
    const w = root.clientWidth || host_win.innerWidth || 0;
    const h = root.clientHeight || host_win.innerHeight || 0;
    return { w: w || 1, h: h || 1 };
  }

  /**
   * 悬浮球可见性: 只有「面板确实还在页面上」时才临时收起球。
   * 面板被外部摘掉时, 球必须自己回来 —— 这是窄屏切换后"球和面板一起消失"的根因。
   */
  function updateBallVisibility() {
    if (!ball_el) return;
    const panelOn = Boolean(panel_el && panel_el.isConnected);
    ball_el.classList.toggle('cpb-ball--hidden', !state.ball_wanted || panelOn);
  }

  // ============================================================================================
  // 自愈: 宿主(酒馆/酒馆助手)在窗口缩放、切换前端界面、重建 iframe 时
  // 可能把我们的 <style>/悬浮球/面板 从 DOM 里摘掉或把面板 iframe 的内容清空。
  // 这里定期巡检 + 在任何交互时机补挂, 保证它们总能长回来。
  // ============================================================================================

  function ensureHosted() {
    try {
      // 宿主重载了脚本: 所有权已经交给新实例, 本实例退场
      if (!stillOwner()) {
        stopWatchdog();
        return;
      }
      const body = host_doc.body;
      if (!body) return;

      // 1) 样式被摘了就补回去 (否则悬浮球/面板会变成没样子的裸元素)
      if (style_el && !style_el.isConnected) {
        (host_doc.head || body).appendChild(style_el);
      }

      // 2) 悬浮球被摘了就补回去; 连元素都没了就直接重建
      if (!ball_el || !ball_el.isConnected) {
        if (ball_el && ball_el.parentNode) {
          body.appendChild(ball_el);
        } else {
          ball_el = null;
          createBall();
        }
      }

      // 3) 面板被摘了就补回去; iframe 内容被清空就重新挂载界面
      if (panel_el) {
        const want_closing = panel_el.classList.contains('cpb-panel--closing');
        if (!want_closing) {
          if (!panel_el.isConnected) {
            body.appendChild(panel_el);
            devLog('面板被宿主摘下, 已重新挂回 body');
          }
          const doc = panel_iframe ? panel_iframe.contentDocument : null;
          if (panel_iframe && !doc) {
            // iframe 彻底坏了: 重建整个面板 iframe
            devLog('面板 iframe 失效, 重建面板');
            reconstructPanelFrame();
          } else if (doc && !doc.querySelector('.cp-app')) {
            // 内容被清空 (srcdoc 重载等): 重新注入界面, 状态都还在内存里
            devLog('面板内容丢失, 重新挂载界面');
            mountPanelApp();
          }
        }
      }

      updateBallVisibility();
    } catch (error) {
      console.warn(LOG_PREFIX, '自愈巡检出错 (不影响使用)', error);
    }
  }

  /** 重建面板 iframe (只在 iframe 不可用时调用) */
  function reconstructPanelFrame() {
    if (!panel_el) return;
    const old = panel_iframe;
    panel_iframe = host_doc.createElement('iframe');
    panel_iframe.className = 'cpb-panel__iframe';
    panel_iframe.setAttribute(MARK, 'panel-iframe');
    panel_iframe.setAttribute('title', '法医尸检报告 · 全屏面板');
    panel_iframe.setAttribute('allow', 'fullscreen');
    panel_iframe.setAttribute('allowfullscreen', 'true');
    panel_iframe.setAttribute('frameborder', '0');
    panel_iframe.srcdoc = buildPanelSrcdoc();
    panel_iframe.addEventListener('load', mountPanelApp);
    if (old && old.parentNode) {
      old.parentNode.replaceChild(panel_iframe, old);
    } else {
      panel_el.appendChild(panel_iframe);
    }
    panel_doc = null;
    panel_refs = null;
  }

  /** 任何交互都顺手巡检一次 (防抖), 保证"点一下就能恢复" */
  function pokeEnsureHosted() {
    if (reattach_timer) return;
    reattach_timer = host_win.setTimeout(() => {
      reattach_timer = null;
      ensureHosted();
    }, 120);
  }

  /** 认领宿主页面 (标记本实例为当前所有者) */
  function claimHost() {
    try {
      host_doc.documentElement.setAttribute(OWNER_ATTR, INSTANCE_TOKEN);
    } catch (error) {
      /* 忽略 */
    }
  }

  /** 判断本实例是否仍是宿主页面的所有者 */
  function stillOwner() {
    try {
      const owner = host_doc.documentElement.getAttribute(OWNER_ATTR);
      return !owner || owner === INSTANCE_TOKEN;
    } catch (error) {
      return true;
    }
  }

  function startWatchdog() {
    stopWatchdog();
    watchdog_timer = host_win.setInterval(ensureHosted, WATCHDOG_MS);
  }

  function stopWatchdog() {
    if (watchdog_timer) {
      host_win.clearInterval(watchdog_timer);
      watchdog_timer = null;
    }
    if (reattach_timer) {
      host_win.clearTimeout(reattach_timer);
      reattach_timer = null;
    }
  }

  function releaseDrag() {
    drag = null;
    if (ball_el) ball_el.classList.remove('cpb-ball--dragging');
  }

  function onPointerDown(event) {
    if (!event.isPrimary) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    releaseDrag();
    drag = {
      pointer_id: event.pointerId,
      start_client_x: event.clientX,
      start_client_y: event.clientY,
      start_left: state.ball_left,
      start_top: state.ball_top,
      moved: false,
    };
    try {
      ball_el.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 忽略 */
    }
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag || drag.pointer_id !== event.pointerId) return;
    const delta_x = event.clientX - drag.start_client_x;
    const delta_y = event.clientY - drag.start_client_y;
    if (!drag.moved) {
      if (Math.hypot(delta_x, delta_y) < DRAG_THRESHOLD) return;
      drag.moved = true;
      ball_el.classList.add('cpb-ball--dragging');
    }
    setBallPosition(drag.start_left + delta_x, drag.start_top + delta_y, false);
  }

  function onPointerUp(event) {
    if (!drag || drag.pointer_id !== event.pointerId) return;
    const was_moved = drag.moved;
    releaseDrag();
    if (was_moved) {
      setBallPosition(state.ball_left, state.ball_top, true);
      return;
    }
    openPanel();
  }

  function onPointerCancel(event) {
    if (drag && drag.pointer_id === event.pointerId) releaseDrag();
  }

  const BALL_ICON =
    '<svg class="cpb-ball__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10.5" cy="10.5" r="6.2"></circle><path d="M15.2 15.2 21 21"></path>' +
    '<path d="M8 10.5h5M10.5 8v5" opacity=".65"></path></svg>';

  function createBall() {
    const size = ballSize();
    ball_el = host_doc.createElement('div');
    ball_el.className = 'cpb-ball';
    ball_el.setAttribute(MARK, 'ball');
    ball_el.setAttribute('script_id', scriptId());
    ball_el.setAttribute('role', 'button');
    ball_el.setAttribute('aria-label', '尸检面板');
    ball_el.title = '点击打开尸检全屏面板 (可拖动)';
    ball_el.style.width = size + 'px';
    ball_el.style.height = size + 'px';
    ball_el.innerHTML = BALL_ICON;
    host_doc.body.appendChild(ball_el);

    const view = viewportSize();
    const fallback_left = view.w - size - 20;
    const fallback_top = view.h - size - 150;
    setBallPosition(
      state.settings.ball_x === null ? fallback_left : state.settings.ball_x,
      state.settings.ball_y === null ? fallback_top : state.settings.ball_y,
      false,
    );

    ball_el.addEventListener('pointerdown', onPointerDown);
    ball_el.addEventListener('pointermove', onPointerMove);
    ball_el.addEventListener('pointerup', onPointerUp);
    ball_el.addEventListener('pointercancel', onPointerCancel);
    ball_el.addEventListener('contextmenu', event => event.preventDefault());
  }

  function toggleBall() {
    state.ball_wanted = !state.ball_wanted;
    updateBallVisibility();
    devLog(state.ball_wanted ? '悬浮球已显示' : '悬浮球已隐藏');
  }

  function onHostResize() {
    // 窗口缩放: 重新夹取球的位置, 顺便确认自身与面板都还在页面上
    setBallPosition(state.ball_left, state.ball_top, false);
    ensureHosted();
    if (panel_doc) layoutFrame();
  }

  // ============================================================================================
  // 酒馆事件: 消息变化时自动刷新数据 (面板关着也保持数据新鲜)
  // ============================================================================================

  function onHostInput(event) {
    if (writing) return;
    if (!isInputEl(event.target)) return;
    scheduleReverseSync();
  }

  function registerTavernEvents() {
    if (typeof eventOn !== 'function' || typeof tavern_events === 'undefined') {
      console.warn(LOG_PREFIX, '当前环境没有酒馆事件接口, 数据不会自动刷新');
      return;
    }
    const scheduleRefresh = () => {
      if (refresh_timer) clearTimeout(refresh_timer);
      refresh_timer = setTimeout(() => {
        refresh_timer = null;
        loadData();
      }, 700);
    };
    const listen = name => {
      try {
        eventOn(tavern_events[name], scheduleRefresh);
      } catch (error) {
        console.warn(LOG_PREFIX, '监听 ' + name + ' 失败', error);
      }
    };
    ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED',
      'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'GENERATION_ENDED'].forEach(listen);
  }

  function registerButtons() {
    if (
      typeof appendInexistentScriptButtons !== 'function' ||
      typeof eventOn !== 'function' ||
      typeof getButtonEvent !== 'function'
    ) {
      console.warn(LOG_PREFIX, '当前环境没有脚本按钮接口, 跳过按钮注册');
      return;
    }
    try {
      appendInexistentScriptButtons([
        { name: OPEN_PANEL_BUTTON, visible: true },
        { name: BALL_TOGGLE_BUTTON, visible: true },
      ]);
      eventOn(getButtonEvent(OPEN_PANEL_BUTTON), () => openPanel());
      eventOn(getButtonEvent(BALL_TOGGLE_BUTTON), () => toggleBall());
    } catch (error) {
      console.warn(LOG_PREFIX, '注册脚本按钮失败', error);
    }
  }

  // ============================================================================================
  // 初始化 / 卸载
  // ============================================================================================

  /** 清掉上一次运行 (脚本被重载时) 留下的 DOM, 避免出现两个悬浮球 */
  function cleanupPreviousInstance() {
    try {
      host_doc.querySelectorAll('[' + MARK + ']').forEach(node => node.remove());
    } catch (error) {
      /* 忽略 */
    }
  }

  function destroy() {
    releaseDrag();
    stopWatchdog();
    if (host_keydown_listener) {
      host_doc.removeEventListener('keydown', host_keydown_listener);
      host_keydown_listener = null;
    }
    if (refresh_timer) clearTimeout(refresh_timer);
    if (reverse_timer) clearTimeout(reverse_timer);
    if (toast_timer) clearTimeout(toast_timer);
    teardownLayoutObserver();
    if (panel_el) {
      panel_el.remove();
      panel_el = null;
      panel_iframe = null;
      panel_doc = null;
      panel_refs = null;
    }
    if (ball_el) {
      ball_el.remove();
      ball_el = null;
    }
    if (style_el) {
      style_el.remove();
      style_el = null;
    }
    host_doc.removeEventListener('input', onHostInput, true);
    host_doc.removeEventListener('pointerdown', pokeEnsureHosted, true);
    host_doc.removeEventListener('click', pokeEnsureHosted, true);
    host_doc.removeEventListener('keydown', pokeEnsureHosted, true);
    host_doc.removeEventListener('visibilitychange', pokeEnsureHosted, true);
    host_win.removeEventListener('resize', onHostResize);
    host_win.removeEventListener('orientationchange', onHostResize);
    host_win.removeEventListener('pageshow', onPageShow);
    try {
      if (host_doc.documentElement.getAttribute(OWNER_ATTR) === INSTANCE_TOKEN) {
        host_doc.documentElement.removeAttribute(OWNER_ATTR);
      }
    } catch (error) {
      /* 忽略 */
    }
    devLog('脚本已卸载');
  }

  /** 页面恢复 (从 bfcache/切后台回来) 时重新确认自身还在 */
  function onPageShow() {
    ensureHosted();
    setBallPosition(state.ball_left, state.ball_top, false);
  }

  /** pagehide: 只有真正卸载页面时才清理; bfcache 里保留 DOM, 否则回来就什么都没有 */
  function onPageHide(event) {
    if (event && event.persisted) {
      return;
    }
    destroy();
  }

  function init(retry) {
    if (!host_doc.body) {
      if ((retry || 0) < 10) {
        host_win.setTimeout(() => init((retry || 0) + 1), 300);
        return;
      }
      console.warn(LOG_PREFIX, '迟迟找不到酒馆网页的 <body>, 悬浮球无法挂载');
      return;
    }

    // 先接管所有权, 再清掉上一次运行留下的节点 (顺序不能反, 否则旧实例可能在同一瞬间补挂回来)
    claimHost();
    cleanupPreviousInstance();
    loadSettings();

    style_el = host_doc.createElement('style');
    style_el.setAttribute(MARK, 'style');
    style_el.setAttribute('script_id', scriptId());
    style_el.textContent = BALL_CSS;
    host_doc.head.appendChild(style_el);

    createBall();
    host_win.addEventListener('resize', onHostResize);
    host_win.addEventListener('orientationchange', onHostResize);
    // 反向同步: 监听酒馆输入框的手动改动 (capture 阶段, 不怕被别的脚本拦住冒泡)
    host_doc.addEventListener('input', onHostInput, true);
    // 自愈: 任何交互都顺手确认球/面板还挂在页面上 (capture, 不干扰酒馆自己的处理)
    host_doc.addEventListener('pointerdown', pokeEnsureHosted, true);
    host_doc.addEventListener('click', pokeEnsureHosted, true);
    host_doc.addEventListener('keydown', pokeEnsureHosted, true);
    host_doc.addEventListener('visibilitychange', pokeEnsureHosted, true);
    host_win.addEventListener('pageshow', onPageShow);

    registerTavernEvents();
    registerButtons();

    // 先预热一次数据, 打开面板时就不用等
    loadData({ render: false });

    // 定期巡检: 宿主要么缩放窗口、要么重建 iframe, 我们总能长回来
    startWatchdog();

    window.addEventListener('pagehide', onPageHide);

    devLog('脚本已加载: 点右下角悬浮球或脚本按钮「' + OPEN_PANEL_BUTTON + '」打开尸检面板');
  }

  // 控制台调试接口
  function exposeDebugApi() {
    try {
      window.__corpseBall = {
        open: openPanel,
        close: closePanel,
        refresh: refreshData,
        state: () => ({
          floors: state.floor_ids.slice(),
          active_id: state.active_id,
          corpses: state.corpses.map(corpse => ({
            id: corpse.id,
            name: corpse.name,
            age: corpse.age,
            mids: corpse.mids.slice(),
            parts: corpse.parts.length,
          })),
          selections: JSON.parse(JSON.stringify(state.selections)),
        }),
        getCommand: buildCommand,
      };
    } catch (error) {
      /* 忽略 */
    }
  }

  try {
    init();
    exposeDebugApi();
  } catch (error) {
    console.error(LOG_PREFIX, '初始化失败', error);
  }
})();
