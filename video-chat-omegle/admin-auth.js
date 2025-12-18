/**
 * Admin Authentication Module
 * للتحقق من صلاحيات الأدمن والتوكن
 */

class AdminAuth {
    constructor() {
        this.tokenKey = 'adminToken';
        this.apiEndpoint = '/api/admin';
        this.init();
    }

    init() {
        // التحقق من التوكن عند تحميل الصفحة
        this.checkAuth();
        
        // إضافة أزرار تسجيل الخروج
        this.addLogoutHandlers();
    }

    /**
     * التحقق من صلاحية التوكن
     */
    async checkAuth() {
        const token = this.getToken();
        
        if (!token) {
            this.redirectToLogin();
            return false;
        }

        try {
            const response = await fetch(`${this.apiEndpoint}/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Invalid token');
            }

            const data = await response.json();
            
            if (data.success) {
                // التوكن صالح، السماح بالدخول
                console.log('Token verified successfully');
                return true;
            } else {
                throw new Error('Token verification failed');
            }
        } catch (error) {
            console.error('Auth check failed:', error);
            this.logout();
            return false;
        }
    }

    /**
     * الحصول على التوكن من localStorage
     */
    getToken() {
        return localStorage.getItem(this.tokenKey);
    }

    /**
     * حفظ التوكن في localStorage
     */
    setToken(token) {
        localStorage.setItem(this.tokenKey, token);
    }

    /**
     * تسجيل الخروج
     */
    logout() {
        localStorage.removeItem(this.tokenKey);
        this.redirectToLogin();
    }

    /**
     * التوجيه إلى صفحة تسجيل الدخول
     */
    redirectToLogin() {
        if (!window.location.pathname.includes('admin-login.html')) {
            window.location.href = '/admin-login.html';
        }
    }

    /**
     * إضافة معالجات تسجيل الخروج
     */
    addLogoutHandlers() {
        // زر تسجيل الخروج في الهيدر
        const logoutButtons = document.querySelectorAll('[data-action="logout"]');
        logoutButtons.forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                this.logout();
            });
        });
    }

    /**
     * إضافة التوكن إلى headers الطلب
     */
    addAuthHeaders(headers = {}) {
        const token = this.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    /**
     * إنشاء طلب مع التوكن
     */
    async authenticatedFetch(url, options = {}) {
        const headers = this.addAuthHeaders(options.headers || {});
        
        const response = await fetch(url, {
            ...options,
            headers
        });

        // إذا كان الرد 401، التوكن قد انتهى
        if (response.status === 401) {
            this.logout();
            throw new Error('Session expired');
        }

        return response;
    }

    /**
     * تحديث التوكن (refresh)
     */
    async refreshToken() {
        try {
            const token = this.getToken();
            if (!token) return false;

            const response = await fetch(`${this.apiEndpoint}/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });

            const data = await response.json();
            
            if (data.success && data.token) {
                this.setToken(data.token);
                return true;
            } else {
                return false;
            }
        } catch (error) {
            console.error('Token refresh failed:', error);
            return false;
        }
    }

    /**
     * التحقق من صلاحيات مستوى معين
     */
    async checkPermission(level) {
        try {
            const response = await this.authenticatedFetch(`${this.apiEndpoint}/permissions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ level })
            });

            const data = await response.json();
            return data.hasPermission || false;
        } catch (error) {
            console.error('Permission check failed:', error);
            return false;
        }
    }

    /**
     * إخفاء أو إظهار العناصر حسب الصلاحيات
     */
    async setupUIBasedOnPermissions() {
        try {
            // التحقق من صلاحيات مختلفة
            const canBan = await this.checkPermission('ban');
            const canBroadcast = await this.checkPermission('broadcast');
            const canViewReports = await this.checkPermission('reports');

            // إخفاء/إظهار عناصر UI
            const banButtons = document.querySelectorAll('[data-permission="ban"]');
            const broadcastButtons = document.querySelectorAll('[data-permission="broadcast"]');
            const reportsSections = document.querySelectorAll('[data-permission="reports"]');

            // تطبيق الصلاحيات
            banButtons.forEach(btn => {
                btn.style.display = canBan ? 'block' : 'none';
            });

            broadcastButtons.forEach(btn => {
                btn.style.display = canBroadcast ? 'block' : 'none';
            });

            reportsSections.forEach(section => {
                section.style.display = canViewReports ? 'block' : 'none';
            });

        } catch (error) {
            console.error('UI setup failed:', error);
        }
    }
}

// تهيئة المصادقة عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', () => {
    // لا نقوم بالتهيئة على صفحة تسجيل الدخول
    if (!window.location.pathname.includes('admin-login.html')) {
        window.adminAuth = new AdminAuth();
    }
});

// وظائف مساعدة عالمية
window.AdminAuthHelpers = {
    /**
     * تسجيل الخروج من أي مكان
     */
    logout() {
        if (window.adminAuth) {
            window.adminAuth.logout();
        } else {
            localStorage.removeItem('adminToken');
            window.location.href = '/admin-login.html';
        }
    },

    /**
     * التحقق من التوكن
     */
    async checkAuth() {
        if (window.adminAuth) {
            return await window.adminAuth.checkAuth();
        }
        return false;
    },

    /**
     * طلب مع مصادقة
     */
    async authFetch(url, options) {
        if (window.adminAuth) {
            return await window.adminAuth.authenticatedFetch(url, options);
        } else {
            // fallback بدون مصادقة
            return await fetch(url, options);
        }
    }
};

// تصدير الكلاس للاستخدام الخارجي
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AdminAuth;
}
