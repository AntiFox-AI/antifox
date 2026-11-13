---
name: mobile-app-security-testing
description: Professional skills and methodology for mobile application security testing
version: 1.0.0
---

# Mobile Application Security Testing

## Overview

Mobile application security testing is an essential part of ensuring the security of mobile apps. This skill provides methods, tools, and best practices for mobile app security testing, covering both Android and iOS platforms.

## Testing Scope

### 1. Application Security

**Items to check:**
- Code obfuscation
- Anti-decompilation protections
- Anti-debugging protections
- Certificate pinning

### 2. Data Security

**Items to check:**
- Data encryption
- Key management
- Sensitive data storage
- Data transmission

### 3. Authentication and Authorization

**Items to check:**
- Authentication mechanisms
- Token management
- Biometric authentication
- Session management

### 4. Communication Security

**Items to check:**
- TLS/SSL configuration
- Certificate validation
- API security
- Protection against man-in-the-middle attacks

## Android Security Testing

### Static Analysis

**Using APKTool:**
```bash
# 反编译APK
apktool d app.apk

# 查看AndroidManifest.xml
cat app/AndroidManifest.xml

# 查看Smali代码
find app/smali -name "*.smali"
```

**Using Jadx:**
```bash
# 反编译APK
jadx -d output app.apk

# 查看Java源码
find output -name "*.java"
```

**Using MobSF:**
```bash
# 启动MobSF
docker run -it -p 8000:8000 opensecurity/mobsf

# 上传APK进行分析
# 访问 http://localhost:8000
```

### Dynamic Analysis

**Using Frida:**
```javascript
// Hook函数
Java.perform(function() {
    var MainActivity = Java.use("com.example.MainActivity");
    MainActivity.onCreate.implementation = function(savedInstanceState) {
        console.log("[*] onCreate called");
        this.onCreate(savedInstanceState);
    };
});
```

**Using Objection:**
```bash
# 启动Objection
objection -g com.example.app explore

# Hook函数
android hooking watch class_method com.example.MainActivity.onCreate
```

**Using Burp Suite:**
```bash
# 配置代理
# Android设置代理指向Burp Suite
# 安装Burp证书
```

### Common Vulnerabilities

**Hardcoded keys:**
```java
// 不安全的代码
String apiKey = "1234567890abcdef";
String password = "admin123";
```

**Insecure storage:**
```java
// SharedPreferences存储敏感数据
SharedPreferences prefs = getSharedPreferences("data", MODE_WORLD_READABLE);
prefs.edit().putString("password", password).apply();
```

**Certificate validation bypass:**
```java
// 不验证证书
TrustManager[] trustAllCerts = new TrustManager[] {
    new X509TrustManager() {
        public X509Certificate[] getAcceptedIssuers() { return null; }
        public void checkClientTrusted(X509Certificate[] certs, String authType) { }
        public void checkServerTrusted(X509Certificate[] certs, String authType) { }
    }
};
```

## iOS Security Testing

### Static Analysis

**Using class-dump:**
```bash
# 导出头文件
class-dump app.ipa

# 查看头文件
find app -name "*.h"
```

**Using Hopper:**
```bash
# 使用Hopper反汇编
# 打开app二进制文件
# 分析汇编代码
```

**Using otool:**
```bash
# 查看Mach-O信息
otool -L app

# 查看字符串
strings app | grep -i "password\|key\|secret"
```

### Dynamic Analysis

**Using Frida:**
```javascript
// Hook Objective-C方法
var className = ObjC.classes.ViewController;
var method = className['- login:password:'];
Interceptor.attach(method.implementation, {
    onEnter: function(args) {
        console.log("[*] Login called");
        console.log("Username: " + ObjC.Object(args[2]).toString());
        console.log("Password: " + ObjC.Object(args[3]).toString());
    }
});
```

**Using Cycript:**
```bash
# 附加到进程
cycript -p app

# 执行命令
[UIApplication sharedApplication]
```

### Common Vulnerabilities

**Hardcoded keys:**
```objective-c
// 不安全的代码
NSString *apiKey = @"1234567890abcdef";
NSString *password = @"admin123";
```

**Insecure storage:**
```objective-c
// Keychain存储不当
NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
[defaults setObject:password forKey:@"password"];
```

**Certificate validation bypass:**
```objective-c
// 不验证证书
- (void)connection:(NSURLConnection *)connection 
didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge {
    [challenge.sender useCredential:[NSURLCredential credentialForTrust:challenge.protectionSpace.serverTrust] 
          forAuthenticationChallenge:challenge];
}
```

## Tool Usage

### MobSF

```bash
# 启动MobSF
docker run -it -p 8000:8000 opensecurity/mobsf

# 上传应用进行分析
# 支持Android和iOS
```

### Frida

```bash
# 安装Frida
pip install frida-tools

# 运行脚本
frida -U -f com.example.app -l script.js
```

### Objection

```bash
# 安装Objection
pip install objection

# 启动Objection
objection -g com.example.app explore
```

### Burp Suite

**Proxy configuration:**
1. Configure the Burp Suite listener
2. Set the proxy on the mobile device
3. Install the Burp certificate
4. Intercept and analyze traffic

## Testing Checklist

### Application Security
- [ ] Code obfuscation check
- [ ] Anti-decompilation protections
- [ ] Anti-debugging protections
- [ ] Certificate pinning

### Data Security
- [ ] Data encryption check
- [ ] Key management
- [ ] Sensitive data storage
- [ ] Data transmission security

### Authentication and Authorization
- [ ] Authentication mechanism testing
- [ ] Token management
- [ ] Session management
- [ ] Biometric authentication

### Communication Security
- [ ] TLS/SSL configuration
- [ ] Certificate validation
- [ ] API security testing
- [ ] Man-in-the-middle attack protection

## Common Security Issues

### 1. Hardcoded Keys

**Problem:**
- Hardcoded API keys
- Hardcoded passwords
- Hardcoded encryption keys

**Fix:**
- Use a key management service
- Use environment variables
- Use secure storage

### 2. Insecure Storage

**Problem:**
- Sensitive data stored in plaintext
- Use of insecure storage methods
- Data not encrypted

**Fix:**
- Use encrypted storage
- Use Keychain/Keystore
- Implement data encryption

### 3. Certificate Validation Bypass

**Problem:**
- SSL certificates not validated
- Self-signed certificates accepted
- Certificate pinning not implemented

**Fix:**
- Implement certificate pinning
- Validate the certificate chain
- Use the system certificate store

### 4. Debug Information Leakage

**Problem:**
- Logs contain sensitive information
- Error messages leak details
- Debug mode not disabled

**Fix:**
- Remove debug code
- Restrict log output
- Disable debugging in production builds

## Best Practices

### 1. Code Security

- Implement code obfuscation
- Disable debug functionality
- Implement anti-debugging protection
- Use certificate pinning

### 2. Data Security

- Encrypt sensitive data
- Use secure storage
- Implement key management
- Restrict data access

### 3. Communication Security

- Use TLS/SSL
- Implement certificate pinning
- Validate server certificates
- Use secure APIs

### 4. Authentication Security

- Implement strong authentication
- Manage tokens securely
- Implement session management
- Use biometric authentication

## Key Considerations

- Only test in authorized environments
- Comply with laws and regulations
- Mind the differences between platforms
- Protect user privacy
