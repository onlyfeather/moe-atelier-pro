import React from 'react'
import {
  Layout,
  Tabs,
  Form,
  Input,
  Radio,
  Button,
  Space,
  Select,
  Table,
  Drawer,
  Typography,
  message,
  Tag,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import {
  fetchAdminUsers,
  createAdminUser,
  fetchAdminConfig,
  updateAdminConfig,
  fetchAdminTasks,
  fetchAdminTaskDetail,
  type AdminUser,
  type AdminConfig,
  type AdminTaskRow,
} from '../utils/adminApi'
import { fetchBackendModels } from '../utils/backendApi'
import {
  API_VERSION_OPTIONS,
  DEFAULT_API_BASES,
  extractVertexProjectId,
  inferApiVersionFromUrl,
  type ApiFormat,
} from '../utils/apiUrl'

const { Header, Content } = Layout
const { Title, Text } = Typography

const formatTime = (value?: number | null) => {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
}

const downloadUrl = (url: string, filename = 'image.png') => {
  if (!url) return
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.click()
}

interface AdminConsoleProps {
  username: string
  onLogout: () => void
}

const AdminConsole: React.FC<AdminConsoleProps> = ({ username, onLogout }) => {
  const [activeTab, setActiveTab] = React.useState('config')
  const [configForm] = Form.useForm<AdminConfig>()
  const [configLoading, setConfigLoading] = React.useState(false)
  const [modelOptions, setModelOptions] = React.useState<{ label: string; value: string }[]>([])
  const [modelLoading, setModelLoading] = React.useState(false)
  const [users, setUsers] = React.useState<AdminUser[]>([])
  const [usersLoading, setUsersLoading] = React.useState(false)
  const [createForm] = Form.useForm()
  const [tasks, setTasks] = React.useState<AdminTaskRow[]>([])
  const [tasksLoading, setTasksLoading] = React.useState(false)
  const [selectedUserId, setSelectedUserId] = React.useState<string | undefined>(undefined)
  const [detailOpen, setDetailOpen] = React.useState(false)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [detailPayload, setDetailPayload] = React.useState<any>(null)

  const loadConfig = React.useCallback(async () => {
    setConfigLoading(true)
    try {
      const config = await fetchAdminConfig()
      configForm.setFieldsValue(config)
    } catch (err) {
      console.error(err)
      message.error('加载全局配置失败')
    } finally {
      setConfigLoading(false)
    }
  }, [configForm])

  const loadUsers = React.useCallback(async () => {
    setUsersLoading(true)
    try {
      const list = await fetchAdminUsers()
      setUsers(list)
    } catch (err) {
      console.error(err)
      message.error('加载用户列表失败')
    } finally {
      setUsersLoading(false)
    }
  }, [])

  const loadTasks = React.useCallback(
    async (userId?: string) => {
      setTasksLoading(true)
      try {
        const list = await fetchAdminTasks(userId)
        setTasks(list)
      } catch (err) {
        console.error(err)
        message.error('加载任务列表失败')
      } finally {
        setTasksLoading(false)
      }
    },
    [],
  )

  React.useEffect(() => {
    void loadConfig()
    void loadUsers()
  }, [loadConfig, loadUsers])

  React.useEffect(() => {
    if (activeTab !== 'tasks') return
    void loadTasks(selectedUserId)
  }, [activeTab, selectedUserId, loadTasks])

  const handleConfigChange = (changed: Partial<AdminConfig>, values: AdminConfig) => {
    if (changed.apiFormat && !values.apiUrl) {
      const apiFormat = (values.apiFormat || 'openai') as ApiFormat
      configForm.setFieldsValue({ apiUrl: DEFAULT_API_BASES[apiFormat] })
    }
    if (changed.apiUrl) {
      const inferred = inferApiVersionFromUrl(values.apiUrl || '')
      if (inferred && inferred !== values.apiVersion) {
        configForm.setFieldsValue({ apiVersion: inferred })
      }
      if ((values.apiFormat || 'openai') === 'vertex') {
        const inferredProject = extractVertexProjectId(values.apiUrl || '')
        if (inferredProject && inferredProject !== values.vertexProjectId) {
          configForm.setFieldsValue({ vertexProjectId: inferredProject })
        }
      }
    }
  }

  const handleSaveConfig = async () => {
    try {
      const values = await configForm.validateFields()
      await updateAdminConfig({
        ...values,
        modelWhitelist: Array.isArray(values.modelWhitelist) ? values.modelWhitelist : [],
      })
      message.success('全局配置已保存')
    } catch (err: any) {
      if (err?.errorFields) return
      console.error(err)
      message.error('保存配置失败')
    }
  }

  const handleFetchModels = async () => {
    setModelLoading(true)
    try {
      const values = configForm.getFieldsValue()
      const list = await fetchBackendModels({
        apiFormat: values.apiFormat,
        apiUrl: values.apiUrl,
        apiVersion: values.apiVersion,
        ignoreWhitelist: true,
      })
      setModelOptions(list)
      const whitelist = list.map((item) => item.value)
      configForm.setFieldsValue({ modelWhitelist: whitelist })
      message.success(`已获取 ${list.length} 个模型并写入白名单`)
    } catch (err) {
      console.error(err)
      message.error('获取模型列表失败')
    } finally {
      setModelLoading(false)
    }
  }

  const handleCreateUser = async () => {
    try {
      const values = await createForm.validateFields()
      await createAdminUser(values)
      message.success('用户创建成功')
      createForm.resetFields()
      void loadUsers()
    } catch (err: any) {
      if (err?.errorFields) return
      console.error(err)
      message.error('创建用户失败')
    }
  }

  const openTaskDetail = async (taskId: string) => {
    setDetailOpen(true)
    setDetailLoading(true)
    try {
      const detail = await fetchAdminTaskDetail(taskId)
      setDetailPayload(detail)
    } catch (err) {
      console.error(err)
      message.error('加载任务详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  const userColumns: ColumnsType<AdminUser> = [
    { title: '用户名', dataIndex: 'username' },
    {
      title: '角色',
      dataIndex: 'role',
      render: (value) => (value === 'admin' ? <Tag color="magenta">管理员</Tag> : <Tag>用户</Tag>),
    },
    {
      title: '状态',
      dataIndex: 'disabled',
      render: (value) => (value ? <Tag color="red">禁用</Tag> : <Tag color="green">正常</Tag>),
    },
    { title: '创建时间', dataIndex: 'created_at', render: (value) => formatTime(value) },
    { title: '最近登录', dataIndex: 'last_login_at', render: (value) => formatTime(value) },
  ]

  const taskColumns: ColumnsType<AdminTaskRow> = [
    { title: '任务ID', dataIndex: 'id', ellipsis: true },
    { title: '用户', dataIndex: 'username' },
    { title: '提示词', dataIndex: 'prompt', ellipsis: true },
    { title: '更新时间', dataIndex: 'updated_at', render: (value) => formatTime(value) },
    {
      title: '操作',
      dataIndex: 'id',
      render: (value) => (
        <Button size="small" onClick={() => openTaskDetail(String(value))}>
          查看
        </Button>
      ),
    },
  ]

  const taskResults = Array.isArray(detailPayload?.task?.results) ? detailPayload.task.results : []

  return (
    <Layout style={{ minHeight: '100vh', background: '#FFF9FA' }}>
      <Header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Space>
          <Title level={4} style={{ margin: 0, color: '#fff' }}>
            管理员控制台
          </Title>
          <Text style={{ color: 'rgba(255,255,255,0.85)' }}>你好，{username}</Text>
        </Space>
        <Button onClick={onLogout}>退出登录</Button>
      </Header>
      <Content style={{ padding: 24 }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          {
            key: 'config',
            label: '全局配置',
            children: (
              <div style={{ maxWidth: 760 }}>
                <Form
                  form={configForm}
                  layout="vertical"
                  onValuesChange={handleConfigChange}
                  disabled={configLoading}
                >
                  <Form.Item name="apiFormat" label="API 格式" initialValue="openai">
                    <Radio.Group optionType="button" buttonStyle="solid">
                      <Radio.Button value="openai">OpenAI</Radio.Button>
                      <Radio.Button value="gemini">Gemini</Radio.Button>
                      <Radio.Button value="vertex">Vertex</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item
                    name="apiUrl"
                    label="API 接口地址"
                    shouldUpdate={(prev, cur) =>
                      (prev as any).apiFormat !== (cur as any).apiFormat
                    }
                  >
                    {({ getFieldValue }) => {
                      const formatValue = (getFieldValue('apiFormat') || 'openai') as ApiFormat
                      const placeholder = DEFAULT_API_BASES[formatValue] || DEFAULT_API_BASES.openai
                      return <Input placeholder={placeholder} />
                    }}
                  </Form.Item>
                  <Form.Item name="apiKey" label="API Key">
                    <Input.Password placeholder="输入 API Key" />
                  </Form.Item>
                  <Form.Item name="apiVersion" label="API 版本">
                    <Select
                      options={API_VERSION_OPTIONS.map((value) => ({ value }))}
                      allowClear
                    />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev, cur) =>
                      (prev as any).apiFormat !== (cur as any).apiFormat
                    }
                  >
                    {({ getFieldValue }) => {
                      const format = getFieldValue('apiFormat')
                      if (format !== 'vertex') return null
                      return (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Form.Item name="vertexProjectId" label="Vertex 项目 ID">
                            <Input />
                          </Form.Item>
                          <Form.Item name="vertexLocation" label="Vertex 区域">
                            <Input placeholder="us-central1" />
                          </Form.Item>
                          <Form.Item name="vertexPublisher" label="Vertex 发布者">
                            <Input placeholder="google" />
                          </Form.Item>
                        </Space>
                      )
                    }}
                  </Form.Item>

                  <Form.Item label="模型白名单" name="modelWhitelist">
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder="选择或粘贴模型名称"
                      options={
                        modelOptions.length
                          ? modelOptions
                          : (configForm.getFieldValue('modelWhitelist') || []).map((value: string) => ({
                              label: value,
                              value,
                            }))
                      }
                    />
                  </Form.Item>
                  <Space>
                    <Button
                      icon={<ReloadOutlined spin={modelLoading} />}
                      onClick={handleFetchModels}
                      loading={modelLoading}
                    >
                      自动获取模型列表
                    </Button>
                    <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveConfig}>
                      保存配置
                    </Button>
                  </Space>
                </Form>
              </div>
            ),
          },
          {
            key: 'users',
            label: '用户管理',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size="large">
                <div style={{ maxWidth: 420 }}>
                  <Title level={5}>创建账号</Title>
                  <Form form={createForm} layout="vertical">
                    <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
                      <Input />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true }]}>
                      <Input.Password />
                    </Form.Item>
                    <Form.Item name="role" label="角色" initialValue="user">
                      <Select
                        options={[
                          { value: 'user', label: '用户' },
                          { value: 'admin', label: '管理员' },
                        ]}
                      />
                    </Form.Item>
                    <Button type="primary" onClick={handleCreateUser}>
                      创建用户
                    </Button>
                  </Form>
                </div>
                <div>
                  <Space style={{ marginBottom: 12 }}>
                    <Title level={5} style={{ margin: 0 }}>
                      用户列表
                    </Title>
                    <Button onClick={loadUsers} loading={usersLoading}>
                      刷新
                    </Button>
                  </Space>
                  <Table
                    rowKey="id"
                    columns={userColumns}
                    dataSource={users}
                    loading={usersLoading}
                    pagination={{ pageSize: 8 }}
                  />
                </div>
              </Space>
            ),
          },
          {
            key: 'tasks',
            label: '任务查看',
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size="large">
                <Space>
                  <Select
                    allowClear
                    style={{ minWidth: 220 }}
                    placeholder="筛选用户"
                    options={users.map((user) => ({ value: user.id, label: user.username }))}
                    onChange={(value) => setSelectedUserId(value)}
                  />
                  <Button onClick={() => loadTasks(selectedUserId)} loading={tasksLoading}>
                    刷新
                  </Button>
                </Space>
                <Table
                  rowKey="id"
                  columns={taskColumns}
                  dataSource={tasks}
                  loading={tasksLoading}
                  pagination={{ pageSize: 8 }}
                />
              </Space>
            ),
          },
        ]} />
      </Content>

      <Drawer
        title="任务详情"
        width={720}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      >
        {detailLoading ? (
          <Text>加载中...</Text>
        ) : detailPayload ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <div>
              <Text strong>用户：</Text>
              <Text>{detailPayload.user?.username || '-'}</Text>
            </div>
            <div>
              <Text strong>提示词：</Text>
              <Text>{detailPayload.task?.prompt || '-'}</Text>
            </div>
            <div>
              <Text strong>结果：</Text>
              <Space direction="vertical" style={{ width: '100%' }} size="large">
                {taskResults.length === 0 ? (
                  <Text type="secondary">暂无结果</Text>
                ) : (
                  taskResults.map((item: any) => {
                    const url = item?.sourceUrl || item?.image || ''
                    const filename = `${item?.id || 'result'}.png`
                    return (
                      <div key={item?.id} style={{ border: '1px solid #eee', borderRadius: 12, padding: 12 }}>
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <div>
                            <Text type="secondary">状态：</Text>
                            <Text>{item?.status || '-'}</Text>
                          </div>
                          {item?.error ? (
                            <Text type="danger">{item.error}</Text>
                          ) : null}
                          {url ? (
                            <img
                              src={url}
                              alt="result"
                              style={{ width: '100%', maxWidth: 520, borderRadius: 8 }}
                            />
                          ) : (
                            <Text type="secondary">未找到图片</Text>
                          )}
                          <Space>
                            {url ? (
                              <Button onClick={() => window.open(url, '_blank', 'noopener')}>查看原图</Button>
                            ) : null}
                            {url ? (
                              <Button onClick={() => downloadUrl(url, filename)}>下载</Button>
                            ) : null}
                          </Space>
                        </Space>
                      </div>
                    )
                  })
                )}
              </Space>
            </div>
          </Space>
        ) : (
          <Text type="secondary">暂无数据</Text>
        )}
      </Drawer>
    </Layout>
  )
}

export default AdminConsole
