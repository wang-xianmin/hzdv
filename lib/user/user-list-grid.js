/**
 * user-list-grid.js — 新人/KV 用户列表 AG Grid（喂PDF0405）
 *
 * 用途：
 * - index.html：「用户列表」弹窗内 init，从 /api/list-kv-users 填充；个人资料保存成功后可 patchRowByKey 同步当前表
 * - 将来超级用户管理、批量改用户名/邮箱等：复制本文件略改列定义与 gridOptions（如 onCellValueChanged 里调 API），
 *   另起容器 div，再 UserListGrid.init({ gridElementId: 'adminUserGrid', ... })
 *
 * 依赖：先加载 ag-grid-community.min.js（agGrid.createGrid）
 */
(function (global) {
    'use strict';

    var state = {
        api: null,
        rowData: [],
        opts: {
            scrollSectionId: 'userListGridSection',
            appendScrollsIntoView: true,
            getDeleteKvUserUrl: null
        },
        ctxMenuEl: null,
        ctxMenuDocHandler: null,
        ctxMenuKeyHandler: null
    };

    var PWD_ZW_RE = /[\u200B-\u200D\uFEFF]/g;
    /** 与 index / functions 口令规范化一致（NFKC → 半角等） */
    function normalizePasswordHalfwidth(raw) {
        return String(raw == null ? '' : raw)
            .replace(PWD_ZW_RE, '')
            .trim()
            .normalize('NFKC');
    }

    function hideUserListContextMenu() {
        if (state.ctxMenuEl && state.ctxMenuEl.parentNode) {
            state.ctxMenuEl.parentNode.removeChild(state.ctxMenuEl);
        }
        state.ctxMenuEl = null;
        if (typeof state.ctxMenuDocHandler === 'function') {
            document.removeEventListener('click', state.ctxMenuDocHandler, true);
            document.removeEventListener('contextmenu', state.ctxMenuDocHandler, true);
        }
        if (typeof state.ctxMenuKeyHandler === 'function') {
            document.removeEventListener('keydown', state.ctxMenuKeyHandler, true);
        }
        state.ctxMenuDocHandler = null;
        state.ctxMenuKeyHandler = null;
    }

    function removeRowByKey(keyStr) {
        if (!keyStr) {
            return false;
        }
        var rows = state.rowData;
        for (var i = rows.length - 1; i >= 0; i--) {
            if (rows[i].key === keyStr) {
                rows.splice(i, 1);
                refreshGrid();
                return true;
            }
        }
        return false;
    }

    /**
     * @param {object} rowData grid 行 data（须含 key）
     */
    function showUserListContextMenu(clientX, clientY, rowData) {
        hideUserListContextMenu();
        var opts = state.opts || {};
        if (!rowData || !rowData.key) {
            return;
        }

        var el = document.createElement('div');
        el.className = 'user-list-grid-ctx-menu';
        el.setAttribute('role', 'menu');
        el.style.cssText =
            'position:fixed;z-index:10000;min-width:120px;background:#fff;border:1px solid #c62828;' +
            'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.18);padding:4px 0;box-sizing:border-box;';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '删除';
        btn.setAttribute('role', 'menuitem');
        btn.style.cssText =
            'display:block;width:100%;padding:10px 16px;border:none;background:transparent;' +
            'text-align:left;font-size:14px;cursor:pointer;color:#b71c1c;font-family:inherit;';
        btn.addEventListener('mouseenter', function () {
            btn.style.background = '#ffebee';
        });
        btn.addEventListener('mouseleave', function () {
            btn.style.background = 'transparent';
        });
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (!confirm('确定要删除吗？')) {
                hideUserListContextMenu();
                return;
            }
            var getUrl = opts.getDeleteKvUserUrl;
            var url = typeof getUrl === 'function' ? getUrl() : '';
            if (!url) {
                alert('未配置删除接口。');
                hideUserListContextMenu();
                return;
            }
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: rowData.key }),
                cache: 'no-store'
            })
                .then(function (r) {
                    return r.text().then(function (text) {
                        var j = null;
                        if (text) {
                            try {
                                j = JSON.parse(text);
                            } catch (err) {
                                console.error('[delete-kv-user] 非 JSON', text.slice(0, 400));
                            }
                        }
                        return { ok: r.ok, j: j, status: r.status };
                    });
                })
                .then(function (x) {
                    hideUserListContextMenu();
                    if (x.j && x.j.success === true) {
                        removeRowByKey(rowData.key);
                        return;
                    }
                    var msg =
                        (x.j && (x.j.error || x.j.msg)) ||
                        ('HTTP ' + (x.status != null ? x.status : '错误'));
                    alert('删除失败：' + msg);
                })
                .catch(function (err) {
                    console.error(err);
                    hideUserListContextMenu();
                    alert('删除失败：网络异常');
                });
        });

        el.appendChild(btn);
        document.body.appendChild(el);
        state.ctxMenuEl = el;

        var w = 124;
        var h = 48;
        var x = Math.max(4, Math.min(clientX, window.innerWidth - w - 4));
        var y = Math.max(4, Math.min(clientY, window.innerHeight - h - 4));
        el.style.left = x + 'px';
        el.style.top = y + 'px';

        state.ctxMenuDocHandler = function (ev) {
            if (el.contains(ev.target)) {
                return;
            }
            hideUserListContextMenu();
        };
        state.ctxMenuKeyHandler = function (ev) {
            if (ev.key === 'Escape') {
                hideUserListContextMenu();
            }
        };
        setTimeout(function () {
            document.addEventListener('click', state.ctxMenuDocHandler, true);
            document.addEventListener('contextmenu', state.ctxMenuDocHandler, true);
            document.addEventListener('keydown', state.ctxMenuKeyHandler, true);
        }, 0);
    }

    function buildRowFromKv(keyStr, valueObj, meta) {
        var st = meta.status;
        if (typeof st !== 'number') st = parseInt(st, 10);
        if (isNaN(st)) st = 0;
        var ban = meta.stfA_perms_can_ban_post;
        if (typeof ban !== 'number') ban = parseInt(ban, 10);
        if (isNaN(ban)) ban = 0;
        var uat = meta.uA_Tier;
        if (typeof uat !== 'number') uat = parseInt(uat, 10);
        if (isNaN(uat)) uat = 0;
        var ubt = meta.uB_Tier;
        if (typeof ubt !== 'number') ubt = parseInt(ubt, 10);
        if (isNaN(ubt)) ubt = 0;
        var uct = meta.uC_Tier;
        if (typeof uct !== 'number') {
            var ucs = String(uct == null ? '' : uct).trim();
            if (/^[01]+$/.test(ucs)) {
                uct = parseInt(ucs, 2);
            } else {
                uct = parseInt(ucs, 10);
            }
        }
        if (isNaN(uct)) uct = 0;
        uct = uct & 15;
        var rawEt = meta.uC_EType;
        if (rawEt == null || rawEt === '') {
            rawEt = meta.uC_work_type;
        }
        var uet = rawEt;
        if (typeof uet !== 'number') {
            var ues = String(uet == null ? '' : uet).trim();
            if (/^[01]+$/.test(ues)) {
                uet = parseInt(ues, 2);
            } else {
                uet = parseInt(ues, 10);
            }
        }
        if (isNaN(uet)) uet = 0;
        uet = uet & 7;
        if (uet === 0) uet = 1;
        var typeStr =
            meta.type != null && String(meta.type) !== ''
                ? String(meta.type)
                : String(meta.uA || '');
        var pwdShow = '';
        if (valueObj.pwd != null) {
            pwdShow = String(valueObj.pwd);
            if (pwdShow.indexOf('$argon2') === 0) {
                // 兼容旧数据：历史版本把哈希串写入了 pwd，列表不展示哈希文本
                pwdShow = '';
            }
        }
        var gRole = valueObj.g_role;
        if (typeof gRole !== 'number') gRole = parseInt(gRole, 10);
        if (isNaN(gRole)) gRole = 0;
        gRole = gRole === 1 ? 1 : 0;
        return {
            key: keyStr,
            uuid: valueObj.uuid != null ? String(valueObj.uuid) : '',
            name: valueObj.name != null ? String(valueObj.name) : '',
            email: valueObj.email != null ? String(valueObj.email) : '',
            pwd: pwdShow,
            pwd_hash:
                valueObj.pwd_hash != null ? String(valueObj.pwd_hash) : '',
            group: valueObj.group != null ? String(valueObj.group) : '',
            g_role: gRole,
            status: st,
            type: typeStr,
            uA_perms: meta.uA_perms != null ? String(meta.uA_perms) : '',
            uA_act_perms: meta.uA_act_perms != null ? String(meta.uA_act_perms) : '',
            stfA_perms_can_ban_post: ban,
            uA_Tier: uat,
            uB_Tier: ubt,
            uC_Tier: uct,
            uC_EType: uet,
            _metaRaw: JSON.parse(JSON.stringify(meta || {})),
            _valueRaw: JSON.parse(JSON.stringify(valueObj || {}))
        };
    }

    /** 与 KV metadata.status（0–3）对应；界面与下拉用中文，底层仍存数字 */
    var STATUS_OPTIONS = ['未激活', '有效', '暂时封禁', '注销'];

    function statusNumToLabel(n) {
        if (typeof n !== 'number') n = parseInt(n, 10);
        if (!isNaN(n) && n >= 0 && n < STATUS_OPTIONS.length) {
            return STATUS_OPTIONS[n];
        }
        return n == null || n === '' ? '' : String(n);
    }

    function statusLabelToNum(s) {
        var i = STATUS_OPTIONS.indexOf(s);
        return i >= 0 ? i : null;
    }

    /**
     * A 类等级 uA_Tier：互斥档位（含 0），只能单选下拉，不能用作位掩码多选
     */
    var UA_TIER_LEVELS = [
        { label: '泛泛之交', value: 0 },
        { label: '弱关系/熟人', value: 1 },
        { label: '普通朋友', value: 2 },
        { label: '亲密朋友', value: 4 },
        { label: '死党', value: 8 },
        { label: '家庭成员', value: 16 }
    ];

    function uA_TierNumToLabel(n) {
        if (typeof n !== 'number') n = parseInt(n, 10);
        if (isNaN(n)) return '';
        for (var i = 0; i < UA_TIER_LEVELS.length; i++) {
            if (UA_TIER_LEVELS[i].value === n) {
                return UA_TIER_LEVELS[i].label;
            }
        }
        return String(n);
    }

    function uA_TierLabelToNum(s) {
        for (var j = 0; j < UA_TIER_LEVELS.length; j++) {
            if (UA_TIER_LEVELS[j].label === s) {
                return UA_TIER_LEVELS[j].value;
            }
        }
        return null;
    }

    function uA_TierLabelsForSelect() {
        return UA_TIER_LEVELS.map(function (x) {
            return x.label;
        });
    }

    /** B 类等级 uB_Tier：互斥档位（含 0），单选下拉 */
    var UB_TIER_LEVELS = [
        { label: '未注册用户', value: 0 },
        { label: '已注册但未付费', value: 1 },
        { label: '普通会员', value: 2 },
        { label: 'vip用户', value: 4 }
    ];

    function uB_TierNumToLabel(n) {
        if (typeof n !== 'number') n = parseInt(n, 10);
        if (isNaN(n)) return '';
        for (var i = 0; i < UB_TIER_LEVELS.length; i++) {
            if (UB_TIER_LEVELS[i].value === n) {
                return UB_TIER_LEVELS[i].label;
            }
        }
        return String(n);
    }

    function uB_TierLabelToNum(s) {
        for (var k = 0; k < UB_TIER_LEVELS.length; k++) {
            if (UB_TIER_LEVELS[k].label === s) {
                return UB_TIER_LEVELS[k].value;
            }
        }
        return null;
    }

    function uB_TierLabelsForSelect() {
        return UB_TIER_LEVELS.map(function (x) {
            return x.label;
        });
    }

    /** C 类等级 uC_Tier：互斥档位（1/2/4/8），单选下拉；无 0 */
    var UC_TIER_LEVELS = [
        { label: '乡镇级', value: 1 },
        { label: '县级', value: 2 },
        { label: '地市级', value: 4 },
        { label: '省级', value: 8 }
    ];

    function uC_TierNumToLabel(n) {
        if (typeof n !== 'number') n = parseInt(n, 10);
        if (isNaN(n)) return '';
        for (var i = 0; i < UC_TIER_LEVELS.length; i++) {
            if (UC_TIER_LEVELS[i].value === n) {
                return UC_TIER_LEVELS[i].label;
            }
        }
        return String(n);
    }

    function uC_TierLabelToNum(s) {
        for (var t = 0; t < UC_TIER_LEVELS.length; t++) {
            if (UC_TIER_LEVELS[t].label === s) {
                return UC_TIER_LEVELS[t].value;
            }
        }
        return null;
    }

    function uC_TierLabelsForSelect() {
        return UC_TIER_LEVELS.map(function (x) {
            return x.label;
        });
    }

    /** C 类用工性质 uC_EType：互斥（1/2/4），单选下拉 */
    var UC_ETYPE_LEVELS = [
        { label: 'A类员工', value: 1 },
        { label: 'B类员工', value: 2 },
        { label: 'C类员工', value: 4 }
    ];

    function uC_ETypeNumToLabel(n) {
        var mask = parsePermBitmask(n);
        if (!mask) return '';
        var labels = [];
        for (var e = 0; e < UC_ETYPE_LEVELS.length; e++) {
            if ((mask & UC_ETYPE_LEVELS[e].value) !== 0) {
                labels.push(UC_ETYPE_LEVELS[e].label);
            }
        }
        return labels.length ? labels.join('、') : String(mask);
    }

    function uC_ETypeLabelToNum(s) {
        for (var g = 0; g < UC_ETYPE_LEVELS.length; g++) {
            if (UC_ETYPE_LEVELS[g].label === s) {
                return UC_ETYPE_LEVELS[g].value;
            }
        }
        return null;
    }

    function uC_ETypeLabelsForSelect() {
        return UC_ETYPE_LEVELS.map(function (x) {
            return x.label;
        });
    }

    /** uA_perms 等掩码：纯 0/1 串按二进制解析，否则按十进制 */
    function parsePermBitmask(val) {
        if (val == null || val === '') return 0;
        var s = String(val).trim();
        if (/^[01]+$/.test(s)) return parseInt(s, 2) || 0;
        var n = parseInt(s, 10);
        return isNaN(n) ? 0 : n;
    }

    /** A 类权限 1：1/2/4/8，存 KV 为 8 位二进制串 */
    var UA_PERMS_FLAG_ITEMS = [
        { label: '新增用户', value: 1 },
        { label: '删除用户', value: 2 },
        { label: '封禁用户', value: 4 },
        { label: '解封用户', value: 8 }
    ];

    /** A 类权限 2（uA_act_perms）：发帖/评论/隐藏/删帖，8 位二进制串 */
    var UA_ACT_PERMS_FLAG_ITEMS = [
        { label: '允许发贴', value: 1 },
        { label: '允许评论', value: 2 },
        { label: '允许隐藏自己的贴', value: 4 },
        { label: '允许删除自己的贴', value: 8 }
    ];

    /** 用户类型 type：掩位与 KV 一致（如 A 类仅勾选 = 16 → 00010000） */
    var TYPE_FLAG_ITEMS = [
        { label: '超级用户', value: 1 },
        { label: '技术调试员', value: 2 },
        { label: '内容审核负责', value: 4 },
        { label: '内容审核员', value: 8 },
        { label: 'A类用户', value: 16 },
        { label: 'B类用户', value: 32 },
        { label: 'C类用户', value: 64 }
    ];

    function bitmaskToBinaryString(mask, width) {
        var w = width != null ? width : 8;
        var max = w >= 31 ? 0xffffffff : (1 << w) - 1;
        var m = (Number(mask) >>> 0) & max;
        return m.toString(2).padStart(w, '0');
    }

    /** 只读格：多选掩码展示为若干 disabled 勾选框（项少、列够宽时用） */
    function cellRendererBitmaskFlags(items, params) {
        var v = parsePermBitmask(params.value);
        var parts = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var checked = (v & it.value) !== 0 ? ' checked' : '';
            parts.push(
                '<label style="margin-right:8px;white-space:nowrap;font-size:11px;line-height:1.3;">' +
                    '<input type="checkbox" disabled' +
                    checked +
                    ' /> ' +
                    it.label +
                    '</label>'
            );
        }
        return parts.join('');
    }

    /**
     * 只读格：掩码 →「已勾选项」中文顿号连接（列窄时避免只看见第一个勾选框被误认为只有「超级用户」）
     */
    function cellRendererBitmaskSummaryText(items, params) {
        var v = parsePermBitmask(params.value);
        var labels = [];
        for (var i = 0; i < items.length; i++) {
            if ((v & items[i].value) !== 0) {
                labels.push(items[i].label);
            }
        }
        var text = labels.join('、');
        return (
            '<span style="font-size:11px;line-height:1.45;display:block;white-space:normal;word-break:break-word;">' +
            (text || '<span style="color:#999;">—</span>') +
            '</span>'
        );
    }

    /**
     * 通用：掩码多选弹出编辑器（cellEditorParams.items + binaryWidth）
     */
    function BitmaskMultiSelectEditor() {}

    BitmaskMultiSelectEditor.prototype.init = function (params) {
        this.params = params;
        // AG Grid 多数版本会把 cellEditorParams 合并进 params，不一定保留 cellEditorParams 对象
        var cep = params.cellEditorParams;
        this.items =
            (cep && cep.items) ||
            params.items ||
            [];
        this.binaryWidth =
            cep && cep.binaryWidth != null
                ? cep.binaryWidth
                : params.binaryWidth != null
                  ? params.binaryWidth
                  : 8;
        var mask = parsePermBitmask(params.value);
        this.eGui = document.createElement('div');
        this.eGui.className = 'bitmask-multi-editor';
        this.eGui.setAttribute('role', 'dialog');
        this.eGui.style.cssText =
            'padding:10px 12px;background:#fff;border:1px solid #ccc;border-radius:8px;' +
            'box-shadow:0 8px 24px rgba(0,0,0,0.15);min-width:220px;max-height:70vh;overflow:auto;' +
            'font-size:13px;box-sizing:border-box;';
        this.rows = [];
        for (var i = 0; i < this.items.length; i++) {
            var it = this.items[i];
            var lab = document.createElement('label');
            lab.style.display = 'flex';
            lab.style.alignItems = 'center';
            lab.style.gap = '6px';
            lab.style.margin = '6px 0';
            lab.style.cursor = 'pointer';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = (mask & it.value) !== 0;
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(it.label));
            this.eGui.appendChild(lab);
            this.rows.push({ box: cb, value: it.value });
        }
        var btnRow = document.createElement('div');
        btnRow.style.marginTop = '10px';
        btnRow.style.textAlign = 'right';
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.textContent = '完成';
        okBtn.style.cssText =
            'padding:5px 14px;font-size:13px;cursor:pointer;border-radius:6px;border:none;' +
            'background:#1976d2;color:#fff;';
        var api = params.api;
        okBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (api && typeof api.stopEditing === 'function') {
                api.stopEditing();
            }
        });
        btnRow.appendChild(okBtn);
        this.eGui.appendChild(btnRow);
    };

    BitmaskMultiSelectEditor.prototype.getGui = function () {
        return this.eGui;
    };

    BitmaskMultiSelectEditor.prototype.getValue = function () {
        var m = 0;
        for (var i = 0; i < this.rows.length; i++) {
            if (this.rows[i].box.checked) {
                m |= this.rows[i].value;
            }
        }
        return bitmaskToBinaryString(m, this.binaryWidth);
    };

    BitmaskMultiSelectEditor.prototype.isPopup = function () {
        return true;
    };

    BitmaskMultiSelectEditor.prototype.getPopupPosition = function () {
        return 'under';
    };

    BitmaskMultiSelectEditor.prototype.afterGuiAttached = function () {
        var first = this.rows[0] && this.rows[0].box;
        if (first && first.focus) {
            first.focus();
        }
    };

    BitmaskMultiSelectEditor.prototype.destroy = function () {};

    function createColumnDefs() {
        var typeTooltip =
            '用户类型掩位（十进制）：1=超级用户，2=技术调试员，4=内容审核负责，8=内容审核员，16=A类用户，32=B类用户，64=C类用户；格内为 8 位二进制串';
        return [
            /** 序号：占两行居中 */
            {
                headerName: '序号',
                marryChildren: true,
                children: [
                    {
                        colId: 'seq',
                        headerName: '',
                        editable: false,
                        pinned: 'left',
                        width: 64,
                        maxWidth: 80,
                        minWidth: 56,
                        flex: 0,
                        suppressSizeToFit: true,
                        sortable: false,
                        filter: false,
                        valueGetter: function (p) {
                            var idx = p.node && p.node.rowIndex;
                            return idx == null || idx < 0 ? '' : idx + 1;
                        }
                    }
                ]
            },
            /** 基本信息 */
            {
                headerName: '基本信息',
                children: [
                    {
                        field: 'key',
                        headerName: 'Key',
                        editable: false,
                        flex: 1
                    },
                    {
                        field: 'uuid',
                        headerName: 'UUID',
                        headerTooltip: 'UUID（列已收拢，可拖动右边界展开）',
                        editable: false,
                        flex: 0,
                        width: 10,
                        minWidth: 4,
                        resizable: true,
                        suppressAutoSize: true
                    },
                    {
                        field: 'name',
                        headerName: 'name',
                        editable: true,
                        flex: 0.8
                    },
                    {
                        field: 'email',
                        headerName: 'email',
                        editable: true,
                        flex: 1
                    },
                    {
                        field: 'pwd',
                        headerName: 'pwd',
                        editable: true,
                        flex: 0.8,
                        valueParser: function (p) {
                            var s = p.newValue == null ? '' : String(p.newValue);
                            if (s.length > 0 && s.charAt(0) === '$') {
                                return s;
                            }
                            return normalizePasswordHalfwidth(s);
                        }
                    },
                    {
                        field: 'group',
                        headerName: 'group',
                        editable: true,
                        flex: 0.65
                    }
                ]
            },
            /** 身份角色 */
            {
                headerName: '身份角色',
                children: [
                    {
                        field: 'g_role',
                        headerName: '组长',
                        editable: true,
                        flex: 0.55,
                        minWidth: 88,
                        maxWidth: 110,
                        suppressSizeToFit: true,
                        valueGetter: function (p) {
                            return !!(p.data && Number(p.data.g_role) === 1);
                        },
                        valueSetter: function (p) {
                            p.data.g_role = p.newValue ? 1 : 0;
                            return true;
                        },
                        cellRenderer: 'agCheckboxCellRenderer',
                        cellEditor: 'agCheckboxCellEditor'
                    },
                    {
                        field: 'status',
                        headerName: 'Status',
                        editable: true,
                        flex: 0.9,
                        valueGetter: function (p) {
                            return statusNumToLabel(p.data && p.data.status);
                        },
                        valueSetter: function (p) {
                            var n = statusLabelToNum(p.newValue);
                            if (n == null) return false;
                            p.data.status = n;
                            return true;
                        },
                        cellEditor: 'agSelectCellEditor',
                        cellEditorParams: {
                            values: STATUS_OPTIONS.slice()
                        }
                    },
                    {
                        field: 'type',
                        headerName: 'type',
                        editable: true,
                        headerTooltip: typeTooltip,
                        tooltipField: 'type',
                        flex: 1.35,
                        cellEditor: BitmaskMultiSelectEditor,
                        cellEditorParams: {
                            items: TYPE_FLAG_ITEMS,
                            binaryWidth: 8
                        },
                        cellRenderer: function (params) {
                            return cellRendererBitmaskSummaryText(TYPE_FLAG_ITEMS, params);
                        }
                    }
                ]
            },
            /** 权限设置 */
            {
                headerName: '权限设置',
                children: [
                    {
                        field: 'uA_perms',
                        headerName: 'A类权限1',
                        editable: true,
                        flex: 0.8,
                        cellEditor: BitmaskMultiSelectEditor,
                        cellEditorParams: {
                            items: UA_PERMS_FLAG_ITEMS,
                            binaryWidth: 8
                        },
                        cellRenderer: function (params) {
                            return cellRendererBitmaskFlags(UA_PERMS_FLAG_ITEMS, params);
                        }
                    },
                    {
                        field: 'uA_act_perms',
                        headerName: 'A类权限2',
                        editable: true,
                        flex: 0.85,
                        cellEditor: BitmaskMultiSelectEditor,
                        cellEditorParams: {
                            items: UA_ACT_PERMS_FLAG_ITEMS,
                            binaryWidth: 8
                        },
                        cellRenderer: function (params) {
                            return cellRendererBitmaskFlags(UA_ACT_PERMS_FLAG_ITEMS, params);
                        }
                    },
                    {
                        field: 'stfA_perms_can_ban_post',
                        headerName: '封禁帖子',
                        editable: false,
                        flex: 0.7
                    }
                ]
            },
            /** 等级/分类 */
            {
                headerName: '等级/分类',
                children: [
                    {
                        field: 'uA_Tier',
                        headerName: 'A类等级',
                        editable: true,
                        flex: 0.75,
                        valueGetter: function (p) {
                            return uA_TierNumToLabel(p.data && p.data.uA_Tier);
                        },
                        valueSetter: function (p) {
                            var n = uA_TierLabelToNum(p.newValue);
                            if (n === null) return false;
                            p.data.uA_Tier = n;
                            return true;
                        },
                        cellEditor: 'agSelectCellEditor',
                        cellEditorParams: {
                            values: uA_TierLabelsForSelect()
                        }
                    },
                    {
                        field: 'uB_Tier',
                        headerName: 'B类等级',
                        editable: true,
                        flex: 0.75,
                        valueGetter: function (p) {
                            return uB_TierNumToLabel(p.data && p.data.uB_Tier);
                        },
                        valueSetter: function (p) {
                            var nb = uB_TierLabelToNum(p.newValue);
                            if (nb === null) return false;
                            p.data.uB_Tier = nb;
                            return true;
                        },
                        cellEditor: 'agSelectCellEditor',
                        cellEditorParams: {
                            values: uB_TierLabelsForSelect()
                        }
                    },
                    {
                        field: 'uC_Tier',
                        headerName: 'C类等级',
                        editable: true,
                        flex: 0.75,
                        cellEditor: BitmaskMultiSelectEditor,
                        cellEditorParams: {
                            items: UC_TIER_LEVELS,
                            binaryWidth: 8
                        },
                        valueFormatter: function (p) {
                            return uC_TierNumToLabel(p.value);
                        },
                        valueParser: function (p) {
                            return parsePermBitmask(p.newValue);
                        },
                        cellRenderer: function (params) {
                            return cellRendererBitmaskFlags(UC_TIER_LEVELS, params);
                        }
                    },
                    {
                        field: 'uC_EType',
                        headerName: 'C类用工性质',
                        editable: true,
                        flex: 0.85,
                        cellEditor: BitmaskMultiSelectEditor,
                        cellEditorParams: {
                            items: UC_ETYPE_LEVELS,
                            binaryWidth: 8
                        },
                        valueFormatter: function (p) {
                            return uC_ETypeNumToLabel(p.value);
                        },
                        valueParser: function (p) {
                            return parsePermBitmask(p.newValue);
                        },
                        cellRenderer: function (params) {
                            return cellRendererBitmaskFlags(UC_ETYPE_LEVELS, params);
                        }
                    }
                ]
            }
        ];
    }

    function scrollIntoViewConfigured() {
        var id = state.opts.scrollSectionId || 'userListGridSection';
        var sec = document.getElementById(id);
        if (sec) {
            sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    function refreshGrid() {
        if (state.api) {
            state.api.setGridOption('rowData', state.rowData.slice());
        }
    }

    global.UserListGrid = {
        /**
         * @param {object} options
         * @param {string} [options.gridElementId='newUsersGrid']
         * @param {string} [options.scrollSectionId='userListGridSection']
         * @param {boolean} [options.appendScrollsIntoView=true] appendFromKv 后是否滚动到表
         * @param {object[]} [options.initialRows] 初始行；未传则为空表
         * @param {object[]} [options.columnDefs] 整表替换列定义（管理端可拷贝 createColumnDefs 再改）
         * @param {object} [options.gridOptions] 合并进 gridOptions，例如 { onCellValueChanged: fn }
         * @param {function(): string} [options.getDeleteKvUserUrl] 删除接口完整 URL
         */
        init: function (options) {
            options = options || {};
            var gridId = options.gridElementId || 'newUsersGrid';
            var el = document.getElementById(gridId);
            if (!el || typeof agGrid === 'undefined' || typeof agGrid.createGrid !== 'function') {
                console.warn('[UserListGrid] AG Grid 未加载或找不到容器 #' + gridId);
                return null;
            }
            hideUserListContextMenu();
            if (state.api && typeof state.api.destroy === 'function') {
                state.api.destroy();
                state.api = null;
            }
            state.opts = {
                scrollSectionId:
                    options.scrollSectionId != null ? options.scrollSectionId : 'userListGridSection',
                appendScrollsIntoView: options.appendScrollsIntoView !== false,
                getDeleteKvUserUrl:
                    typeof options.getDeleteKvUserUrl === 'function' ? options.getDeleteKvUserUrl : null
            };
            state.rowData = options.initialRows ? options.initialRows.slice() : [];

            var columnDefs = options.columnDefs || createColumnDefs();
            var userGridOpts =
                options.gridOptions && typeof options.gridOptions === 'object' ? options.gridOptions : {};
            var userOnCellContextMenu = userGridOpts.onCellContextMenu;

            var gridOptions = {
                columnDefs: columnDefs,
                rowData: state.rowData.slice(),
                /** 两行表头：group 行 + 叶子列行 */
                groupHeaderHeight: 40,
                headerHeight: 42,
                defaultColDef: {
                    sortable: true,
                    filter: false,
                    resizable: true,
                    wrapHeaderText: true,
                    autoHeaderHeight: false,
                    suppressHeaderMenuButton: true,
                    suppressHeaderFilterButton: true
                },
                tooltipShowDelay: 200,
                rowClassRules: {
                    'user-list-row-leader': function (params) {
                        var d = params && params.data;
                        return !!(d && Number(d.g_role) === 1);
                    }
                },
                onCellContextMenu: function (params) {
                    if (typeof userOnCellContextMenu === 'function') {
                        userOnCellContextMenu(params);
                    }
                    if (!params || !params.event) {
                        return;
                    }
                    var o = state.opts;
                    if (typeof o.getDeleteKvUserUrl !== 'function') {
                        return;
                    }
                    params.event.preventDefault();
                    if (!params.node || params.node.rowPinned) {
                        return;
                    }
                    var data = params.node.data;
                    if (!data) {
                        return;
                    }
                    showUserListContextMenu(params.event.clientX, params.event.clientY, data);
                }
            };
            Object.keys(userGridOpts).forEach(function (k) {
                if (k === 'onCellContextMenu') {
                    return;
                }
                gridOptions[k] = userGridOpts[k];
            });
            state.api = agGrid.createGrid(el, gridOptions);
            return state.api;
        },

        appendFromKv: function (keyStr, valueObj, meta) {
            if (!state.api) {
                console.warn('[UserListGrid] 未 init，忽略 appendFromKv');
                return;
            }
            var row = buildRowFromKv(keyStr, valueObj, meta);
            state.rowData.push(row);
            refreshGrid();
            if (state.opts.appendScrollsIntoView !== false) {
                scrollIntoViewConfigured();
            }
        },

        /** 按 key（如 phone:138xxx）更新行内展示字段，用于个人资料保存后同步表格 */
        removeRowByKey: function (keyStr) {
            return removeRowByKey(keyStr);
        },

        patchRowByKey: function (keyStr, valuePatch) {
            if (!keyStr || !valuePatch || typeof valuePatch !== 'object') return false;
            var rows = state.rowData;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].key === keyStr) {
                    if (valuePatch.name != null) rows[i].name = String(valuePatch.name);
                    if (valuePatch.pwd != null) rows[i].pwd = String(valuePatch.pwd);
                    if (valuePatch.email != null) rows[i].email = String(valuePatch.email);
                    if (valuePatch.uuid != null) rows[i].uuid = String(valuePatch.uuid);
                    if (valuePatch.group != null) rows[i].group = String(valuePatch.group);
                    if (valuePatch.g_role != null) {
                        rows[i].g_role = Number(valuePatch.g_role) === 1 ? 1 : 0;
                    }
                    refreshGrid();
                    return true;
                }
            }
            return false;
        },

        scrollIntoView: function () {
            scrollIntoViewConfigured();
        },

        getApi: function () {
            return state.api;
        },

        getRowData: function () {
            return state.rowData.slice();
        },

        setRowData: function (rows) {
            state.rowData = Array.isArray(rows) ? rows.slice() : [];
            refreshGrid();
        },

        buildRowFromKv: buildRowFromKv,
        createColumnDefs: createColumnDefs,

        /** 组长专用：精简列定义，全部只读，不含 pwd/uuid/用户类型/权限/等级 */
        createLeaderColumnDefs: function () {
            return [
                {
                    colId: 'seq', headerName: '序号', editable: false, pinned: 'left',
                    width: 64, maxWidth: 80, minWidth: 56, flex: 0,
                    suppressSizeToFit: true, sortable: false, filter: false,
                    valueGetter: function (p) {
                        var idx = p.node && p.node.rowIndex;
                        return idx == null || idx < 0 ? '' : idx + 1;
                    }
                },
                { field: 'key', headerName: 'Key', editable: false, flex: 1 },
                { field: 'name', headerName: 'name（用户名）', editable: false, flex: 0.8 },
                { field: 'email', headerName: 'email（邮箱）', editable: false, flex: 1 },
                { field: 'group', headerName: '小组（group）', editable: false, flex: 0.65 },
                {
                    field: 'g_role', headerName: '组长', editable: false, flex: 0.55,
                    minWidth: 88, maxWidth: 110, suppressSizeToFit: true,
                    valueGetter: function (p) { return !!(p.data && Number(p.data.g_role) === 1); },
                    cellRenderer: 'agCheckboxCellRenderer'
                },
                {
                    field: 'status', headerName: '用户状态（Status）', editable: false, flex: 0.9,
                    valueGetter: function (p) { return statusNumToLabel(p.data && p.data.status); }
                }
            ];
        }
    };
})(typeof window !== 'undefined' ? window : this);
