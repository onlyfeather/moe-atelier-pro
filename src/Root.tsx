import React from 'react'
import { Layout, Form, Input, Button, Space, Typography, Card, message } from 'antd'
import App from './App'
import AdminConsole from './components/AdminConsole'
import { fetchCaptcha, fetchMe, login, logout, type AuthUser } from './utils/authApi'

const { Content } = Layout
const { Title, Text } = Typography

const Root: React.FC = () => {
  const [user, setUser] = React.useState<AuthUser | null>(null)
  const [authLoading, setAuthLoading] = React.useState(true)
  const [captchaSvg, setCaptchaSvg] = React.useState('')
  const [captchaId, setCaptchaId] = React.useState('')
  const [captchaLoading, setCaptchaLoading] = React.useState(false)
  const [loginLoading, setLoginLoading] = React.useState(false)
  const [form] = Form.useForm()

  const refreshCaptcha = React.useCallback(async () => {
    setCaptchaLoading(true)
    try {
      const data = await fetchCaptcha()
      setCaptchaSvg(data.svg || '')
      setCaptchaId(data.id || '')
      form.setFieldsValue({ captchaCode: '' })
    } catch (err) {
      console.error(err)
      message.error('获取验证码失败')
    } finally {
      setCaptchaLoading(false)
    }
  }, [form])

  const loadMe = React.useCallback(async () => {
    setAuthLoading(true)
    try {
      const data = await fetchMe()
      setUser(data.user || null)
    } catch (err) {
      setUser(null)
    } finally {
      setAuthLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadMe()
  }, [loadMe])

  React.useEffect(() => {
    if (user) return
    void refreshCaptcha()
  }, [user, refreshCaptcha])

  const handleLogin = async () => {
    try {
      const values = await form.validateFields()
      if (!captchaId) {
        await refreshCaptcha()
        message.warning('请重新输入验证码')
        return
      }
      setLoginLoading(true)
      const data = await login({
        username: values.username,
        password: values.password,
        captchaId,
        captchaCode: values.captchaCode,
      })
      setUser(data.user)
      message.success('登录成功')
    } catch (err) {
      if (err?.errorFields) return
      console.error(err)
      message.error('登录失败，请检查账号或验证码')
      await refreshCaptcha()
    } finally {
      setLoginLoading(false)
    }
  }

  const handleLogout = async () => {
    try {
      await logout()
    } catch (err) {
      console.error(err)
    } finally {
      setUser(null)
      void refreshCaptcha()
    }
  }

  if (authLoading) {
    return (
      <Layout style={{ minHeight: '100vh', background: '#FFF9FA' }}>
        <Content style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text>正在验证登录状态...</Text>
        </Content>
      </Layout>
    )
  }

  if (!user) {
    return (
      <Layout style={{ minHeight: '100vh', background: '#FFF9FA' }}>
        <Content style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <Card style={{ width: 360 }} bordered>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <div>
                <Title level={4} style={{ margin: 0 }}>
                  账号登录
                </Title>
                <Text type="secondary">请输入管理员预创建的账号</Text>
              </div>
              <Form form={form} layout="vertical">
                <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
                  <Input placeholder="请输入用户名" />
                </Form.Item>
                <Form.Item name="password" label="密码" rules={[{ required: true }]}>
                  <Input.Password placeholder="请输入密码" />
                </Form.Item>
                <Form.Item name="captchaCode" label="验证码" rules={[{ required: true }]}>
                  <Input
                    placeholder="请输入验证码"
                    addonAfter={
                      <Button
                        size="small"
                        onClick={refreshCaptcha}
                        loading={captchaLoading}
                      >
                        刷新
                      </Button>
                    }
                  />
                </Form.Item>
                <div
                  style={{
                    background: '#fff',
                    border: '1px solid #eee',
                    borderRadius: 8,
                    padding: 8,
                    textAlign: 'center',
                  }}
                  dangerouslySetInnerHTML={{ __html: captchaSvg }}
                />
                <Button type="primary" block onClick={handleLogin} loading={loginLoading}>
                  登录
                </Button>
              </Form>
            </Space>
          </Card>
        </Content>
      </Layout>
    )
  }

  if (user.role === 'admin') {
    return <AdminConsole username={user.username} onLogout={handleLogout} />
  }

  return <App onLogout={handleLogout} />
}

export default Root
