(function () {
    'use strict';

    // 1. HTML 模板注入
    var template = '' +
        '<div class="profile-modal-overlay" id="userListModalOverlay" aria-hidden="true">' +
            '<div class="profile-modal-sheet user-list-modal-sheet" role="dialog" aria-modal="true" aria-labelledby="userListModalTitle">' +
                '<button type="button" class="profile-modal-close" id="userListModalCloseBtn" aria-label="关闭">&times;</button>' +
                '<div class="user-list-modal-head">' +
                    '<div class="user-list-modal-head-left">' +
                        '<h2 id="userListModalTitle" class="user-list-modal-title">用户列表</h2>' +
                        '<div class="user-list-modal-search">' +
                            '<span class="user-list-modal-search-label">手机号</span>' +
                            '<input ' +
                                'type="text" ' +
                                'id="userListSearchPhoneInput" ' +
                                'class="user-list-modal-search-input" ' +
                                'placeholder="输入手机号后回车" ' +
                                'inputmode="numeric" ' +
                                'aria-label="输入手机号并回车定位" ' +
                            '/>' +
                        '</div>' +
                        '<div class="user-list-modal-search">' +
                            '<select id="userListTypeFilterSelect" class="user-list-modal-filter-select" aria-label="按用户类型筛选">' +
                                '<option value="1">超级用户</option>' +
                                '<option value="2">技术调试员</option>' +
                                '<option value="4">内容审核负责</option>' +
                                '<option value="8">内容审核员</option>' +
                                '<option value="16" selected>A类用户</option>' +
                                '<option value="32">B类用户</option>' +
                                '<option value="64">C类用户</option>' +
                            '</select>' +
                        '</div>' +
                        '<div class="user-list-modal-search user-list-modal-search--ctier">' +
                            '<select id="userListCTierFilterSelect" class="user-list-modal-filter-select" aria-label="按C类等级筛选">' +
                                '<option value="1">乡镇级</option>' +
                                '<option value="2">县级</option>' +
                                '<option value="4" selected>地市级</option>' +
                                '<option value="8">省级</option>' +
                            '</select>' +
                        '</div>' +
                        '<div class="user-list-modal-search">' +
                            '<label class="user-list-show-all-label">' +
                                '<input type="checkbox" id="userListShowAllCheckbox" checked />' +
                                '全部' +
                            '</label>' +
                        '</div>' +
                        '<div class="user-list-modal-search">' +
                            '<button type="button" id="userListRebuildGroupIndexBtn" class="user-list-modal-filter-btn">重建组索引</button>' +
                            '<button type="button" id="userListRefreshGroupInviteCodesBtn" class="user-list-modal-filter-btn">' +
                                '刷新邀请码' +
                            '</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<div class="user-list-default-group-row" aria-label="新人默认组与组长邀请链接">' +
                    '<div class="user-list-default-group-row-inner">' +
                        '<span class="user-list-modal-search-label">新人默认组（无邀请链接，存 KV）</span>' +
                        '<input ' +
                            'type="text" ' +
                            'id="userListDefaultRegisterGroupInput" ' +
                            'class="user-list-modal-search-input" ' +
                            'placeholder="如 85" ' +
                            'maxlength="24" ' +
                            'aria-label="默认组号" ' +
                        '/>' +
                        '<button type="button" id="userListDefaultRegisterGroupSaveBtn" class="user-list-modal-filter-btn">保存</button>' +
                        '<button ' +
                            'type="button" ' +
                            'id="userListDefaultRegisterGroupClearBtn" ' +
                            'class="user-list-modal-filter-btn user-list-modal-filter-btn--secondary" ' +
                        '>' +
                            '清空' +
                        '</button>' +
                        '<span id="userListInviteLinkHint" class="user-list-invite-hint" role="note"></span>' +
                    '</div>' +
                '</div>' +
                '<div class="user-manage-split">' +
                    '<div class="user-manage-tree-column" aria-label="小组树与分组折叠">' +
                        '<div class="user-manage-tree-pane">' +
                            '<div id="userManageGroupTree" class="user-manage-tree-list"></div>' +
                        '</div>' +
                        '<div class="user-manage-tree-footer">' +
                            '<label class="user-manage-tree-collapse-check">' +
                                '<input type="checkbox" id="userManageCollapseGroupsCheckbox" checked />' +
                                '<span>分组显示，整组折叠</span>' +
                            '</label>' +
                        '</div>' +
                    '</div>' +
                    '<div id="userListModalScrollSection" class="user-list-grid-section user-list-modal-scroll" aria-label="用户列表表格">' +
                        '<div id="userListModalGrid" class="ag-theme-quartz" role="grid"></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';

    var container = document.createElement('div');
    container.style.display = 'none';
    container.innerHTML = template;
    document.body.appendChild(container.firstElementChild);

    // 2. DOM 引用初始化（挂到 window，login.js 会引用）
    window.userListModalOverlay = document.getElementById('userListModalOverlay');
    window.userListModalCloseBtn = document.getElementById('userListModalCloseBtn');
    window.userListSearchPhoneInput = document.getElementById('userListSearchPhoneInput');
    window.userListTypeFilterSelect = document.getElementById('userListTypeFilterSelect');
    window.userListCTierFilterSelect = document.getElementById('userListCTierFilterSelect');
    window.userListShowAllCheckbox = document.getElementById('userListShowAllCheckbox');
    window.userListRebuildGroupIndexBtn = document.getElementById('userListRebuildGroupIndexBtn');
    window.userListRefreshGroupInviteCodesBtn = document.getElementById('userListRefreshGroupInviteCodesBtn');
    window.userListDefaultRegisterGroupInput = document.getElementById('userListDefaultRegisterGroupInput');
    window.userListDefaultRegisterGroupSaveBtn = document.getElementById('userListDefaultRegisterGroupSaveBtn');
    window.userListDefaultRegisterGroupClearBtn = document.getElementById('userListDefaultRegisterGroupClearBtn');
    window.userListInviteLinkHint = document.getElementById('userListInviteLinkHint');
    window.userManageGroupTree = document.getElementById('userManageGroupTree');
    window.userManageCollapseGroupsCheckbox = document.getElementById('userManageCollapseGroupsCheckbox');

    // 状态变量也需要暴露给 login.js
    window.userListSaveDebounceByKey = {};
    window.userListModalBodyOverflowPrev = '';
    window.userListSearchDebounceTimer = null;
    window.userListAllRowsCache = [];
    window.userManageSelectedGroup = '';
    window.userManageTreeCollapsed = { nav: false, groups: false };
    window.userManageExpandedGroups = {};
    window.userManageGroupInviteCodeCache = Object.create(null);
    window.userListModal = {
        /**
         * 个人资料保存后同步表格行
         * @param {string} keyStr - 行 key，如 "phone:138xxx"
         * @param {string} [name] - 可选，新名字
         * @param {string} [pwd]  - 可选，新密码
         * @returns {boolean}
         */
        syncProfileChange: function (keyStr, name, pwd) {
            if (!window.UserListGrid || typeof UserListGrid.patchRowByKey !== 'function') {
                return false;
            }
            return UserListGrid.patchRowByKey(keyStr, { name: name, pwd: pwd });
        }
    };
})();
