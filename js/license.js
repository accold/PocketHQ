const License = (() => {
    const KEY_LICENSE       = 'pockethq_license';
    const KEY_HWID          = 'pockethq_hwid';
    const KEY_LAST_VERIFIED = 'pockethq_lv';
    const OFFLINE_GRACE_DAYS = 7;

    // ── HWID ────────────────────────────────────────────────
    function generateHWID() {
        // Read from localStorage (primary) — if cleared by iOS, generate a new one
        let hwid = safeGet(KEY_HWID);
        if (!hwid) {
            hwid = 'hwid_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
            safeSet(KEY_HWID, hwid);
        }
        return hwid;
    }

    // ── safe localStorage wrappers (Safari private mode throws) ──
    function safeGet(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }
    function safeSet(key, val) {
        try { localStorage.setItem(key, val); } catch {}
    }

    function getStoredLicense() { return safeGet(KEY_LICENSE); }

    // ── ACTIVATE ────────────────────────────────────────────
    async function activate(licenseKey, email) {
        const hwid = generateHWID();

        // 1. Check Supabase first — promo keys bypass Gumroad entirely
        let existing;
        try {
            existing = await supabaseFetch('GET', `licenses?license_key=eq.${licenseKey}`);
        } catch {
            return { success: false, message: 'Could not connect to activation server. Check your connection and try again.' };
        }

        const isPromo = existing && existing.length > 0 && existing[0].is_promo === true;

        // 2. Key must exist in Supabase (inserted by webhook on purchase, or promo)
        if (!existing || existing.length === 0) {
            return { success: false, message: 'Invalid license key. Make sure you are using the key from your purchase email.' };
        }

        if (existing && existing.length > 0) {
            const record = existing[0];

            if (record.hwid && record.hwid !== hwid) {
                // Different HWID — only allow if reset was approved
                if (record.reset_requested === true) {
                    await supabaseFetch('PATCH', `licenses?license_key=eq.${licenseKey}`, {
                        hwid, email,
                        activated_at: new Date().toISOString(),
                        reset_requested: false,
                    }).catch(() => {});
                } else {
                    return { success: false, message: 'This license is already active on another device. Use "Request Device Reset" to transfer it.' };
                }
            } else {
                // Same device or no HWID yet — update
                await supabaseFetch('PATCH', `licenses?license_key=eq.${licenseKey}`, {
                    hwid, email,
                    activated_at: new Date().toISOString(),
                    reset_requested: false,
                }).catch(() => {});
            }
        } else {
            // First activation
            await supabaseFetch('POST', 'licenses', {
                license_key: licenseKey,
                hwid, email,
                activated_at: new Date().toISOString(),
                reset_requested: false,
            }).catch(() => {});
        }

        safeSet(KEY_LICENSE, JSON.stringify({ key: licenseKey, email, hwid }));
        safeSet(KEY_LAST_VERIFIED, Date.now().toString());
        return { success: true };
    }

    // ── VERIFY ──────────────────────────────────────────────
    async function verify() {
        if (CONFIG.DEV_MODE) return true;

        const stored = getStoredLicense();
        if (!stored) return false;

        let parsed;
        try { parsed = JSON.parse(stored); } catch { return false; }

        const { key, hwid } = parsed;
        const currentHWID = generateHWID();

        // HWID mismatch — iOS cleared storage, or different device
        if (hwid !== currentHWID) return false;

        // Try online verification
        try {
            const record = await supabaseFetch('GET', `licenses?license_key=eq.${key}`);
            if (!record || record.length === 0) return false;
            const valid = record[0].hwid === currentHWID;
            if (valid) safeSet(KEY_LAST_VERIFIED, Date.now().toString());
            return valid;
        } catch {
            // Offline — use grace period
            const lastVerified = parseInt(safeGet(KEY_LAST_VERIFIED) || '0');
            const daysSince = (Date.now() - lastVerified) / 86400000;
            if (daysSince < OFFLINE_GRACE_DAYS) return true; // let them in
            return false; // grace period expired, need to be online once
        }
    }

    // ── REQUEST RESET ────────────────────────────────────────
    async function requestReset() {
        const stored = getStoredLicense();
        if (!stored) return { success: false, message: 'No license found on this device.' };

        let parsed;
        try { parsed = JSON.parse(stored); } catch { return { success: false, message: 'Could not read license.' }; }

        const { key } = parsed;
        try {
            await supabaseFetch('PATCH', `licenses?license_key=eq.${key}`, { reset_requested: true });
            return { success: true, message: 'Reset request submitted. You\'ll be able to reactivate on your new device once approved.' };
        } catch {
            return { success: false, message: 'Could not reach server. Check your connection.' };
        }
    }

    // ── GUMROAD ──────────────────────────────────────────────
    async function verifyGumroad(licenseKey) {
        if (!CONFIG.GUMROAD_PRODUCT_ID) return { success: true }; // dev mode skip
        try {
            const res = await fetch('https://tiny-darkness-3932.averageviewer711.workers.dev/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `product_id=${CONFIG.GUMROAD_PRODUCT_ID}&license_key=${encodeURIComponent(licenseKey)}`,
            });
            const data = await res.json();
            return data.success ? { success: true } : { success: false, message: 'Invalid license key.' };
        } catch {
            return { success: false, message: 'Could not verify license. Check your connection and try again.' };
        }
    }

    // ── SUPABASE ─────────────────────────────────────────────
    async function supabaseFetch(method, path, body) {
        const opts = {
            method,
            headers: {
                'apikey': CONFIG.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': method === 'POST' ? 'return=minimal' : 'return=representation',
            },
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${path}`, opts);
        if (method === 'GET') return res.json();
        return res;
    }

    return { activate, verify, requestReset, generateHWID };
})();
