import React from 'react';
import {
  AutoComplete,
  Button,
  Collapse,
  Divider,
  Drawer,
  Form,
  Input,
  Radio,
  Select,
  Space,
  Switch,
  Tooltip,
  Typography,
  Row,
  Col,
} from 'antd';
import {
  ApiFilled,
  ReloadOutlined,
  SettingFilled,
  ThunderboltFilled,
} from '@ant-design/icons';
import type { FormInstance } from 'antd/es/form';
import type { AppConfig } from '../types/app';
import type { ApiFormat } from '../utils/apiUrl';
import { API_VERSION_OPTIONS, DEFAULT_API_BASES } from '../utils/apiUrl';
import { ASPECT_RATIO_OPTIONS, IMAGE_SIZE_OPTIONS, SAFETY_OPTIONS } from '../app/constants';
import LazySliderInput from '../shared/ui/LazySliderInput';

const { Text } = Typography;

interface ConfigDrawerProps {
  visible: boolean;
  config: AppConfig;
  form: FormInstance<AppConfig>;
  onClose: () => void;
  onConfigChange: (changedValues: Partial<AppConfig>, values: AppConfig) => void;
  models: { label: string; value: string }[];
  loadingModels: boolean;
  fetchModels: () => void;
}

const ConfigDrawer: React.FC<ConfigDrawerProps> = ({
  visible,
  config,
  form,
  onClose,
  onConfigChange,
  models,
  loadingModels,
  fetchModels,
}) => (
  <Drawer
    title={
      <Space>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            background: '#FFF0F3',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#FF9EB5',
          }}
        >
          <SettingFilled />
        </div>
        <span style={{ fontWeight: 800, fontSize: 18, color: '#665555' }}>生成设置</span>
      </Space>
    }
    placement="right"
    onClose={onClose}
    open={visible}
    width={400}
    styles={{ body: { padding: 24 } }}
  >
    <Form layout="vertical" initialValues={config} onValuesChange={onConfigChange} form={form}>
      <div style={{ display: 'none' }}>
        <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>API 格式</span>}>
        <Form.Item name="apiFormat" noStyle>
          <Radio.Group optionType="button" buttonStyle="solid">
            <Radio.Button value="openai">OpenAI</Radio.Button>
            <Radio.Button value="gemini">Gemini</Radio.Button>
            <Radio.Button value="vertex">Vertex</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </Form.Item>

      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}>
        {({ getFieldValue }) => {
          const apiFormat = getFieldValue('apiFormat') || 'openai';
          if (apiFormat === 'openai') {
            return null;
          }
          return (
            <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>API 版本</span>}>
              <Form.Item name="apiVersion" noStyle>
                <AutoComplete
                  options={API_VERSION_OPTIONS.map((version) => ({ value: version }))}
                  filterOption={(inputValue, option) =>
                    option!.value.toUpperCase().indexOf(inputValue.toUpperCase()) !== -1
                  }
                >
                  <Input size="large" placeholder="v1beta" prefix={<ApiFilled style={{ color: '#FF9EB5' }} />} />
                </AutoComplete>
              </Form.Item>
            </Form.Item>
          );
        }}
      </Form.Item>

      <Form.Item
        label={<span style={{ fontWeight: 700, color: '#665555' }}>API 接口地址</span>}
        shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}
      >
        {({ getFieldValue }) => {
          const format = (getFieldValue('apiFormat') || 'openai') as ApiFormat;
          const placeholder = DEFAULT_API_BASES[format] || DEFAULT_API_BASES.openai;
          return (
            <Form.Item name="apiUrl" noStyle>
              <Input size="large" placeholder={placeholder} prefix={<ApiFilled style={{ color: '#FF9EB5' }} />} />
            </Form.Item>
          );
        }}
      </Form.Item>

      </div>
      <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>模型名称</span>} style={{ marginBottom: 48 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Form.Item name="model" noStyle>
              <Select
                showSearch
                allowClear
                className="model-autocomplete"
                options={models}
                placeholder="选择模型"
                optionFilterProp="label"
                filterOption={(inputValue, option) =>
                  option!.value.toUpperCase().indexOf(inputValue.toUpperCase()) !== -1
                }
                dropdownMatchSelectWidth={false}
                dropdownStyle={{ minWidth: 300 }}
                onDropdownVisibleChange={(open) => {
                  if (!open || loadingModels) return;
                  if (models.length === 0) fetchModels();
                }}
              />
            </Form.Item>
          </div>
          <Tooltip title="获取模型列表">
            <Button
              className="model-refresh-btn"
              icon={<ReloadOutlined spin={loadingModels} />}
              onClick={fetchModels}
              size="large"
              shape="circle"
            />
          </Tooltip>
        </div>
      </Form.Item>

      <div
        style={{
          background: '#F8F9FA',
          padding: '16px',
          borderRadius: 16,
          marginBottom: 24,
          border: '1px solid #eee',
        }}
      >
        <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>流式传输</span>} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              启用实时生成进度更新
            </Text>
            <Form.Item name="stream" valuePropName="checked" noStyle>
              <Switch />
            </Form.Item>
          </div>
        </Form.Item>

        <Form.Item label={<span style={{ fontWeight: 700, color: '#665555' }}>图片收纳</span>} style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              自动收纳生成的图片和提示词
            </Text>
            <Form.Item name="enableCollection" valuePropName="checked" noStyle>
              <Switch />
            </Form.Item>
          </div>
        </Form.Item>
      </div>

      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.apiFormat !== cur.apiFormat}>
        {({ getFieldValue }) => {
          const apiFormat = getFieldValue('apiFormat') || 'openai';
          if (apiFormat === 'openai') {
            return null;
          }
          return (
            <Collapse
              ghost
              items={[
                {
                  key: '1',
                  label: <span style={{ fontWeight: 700, color: '#8B5E34' }}>高级设置（Gemini / Vertex）</span>,
                  style: { background: '#FFF7E6', borderRadius: 16, border: '1px dashed #FFD591', marginBottom: 24 },
                  children: (
                    <div>
                      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>思考配置</Text>
                      <Form.Item
                        name="includeThoughts"
                        label={<span style={{ fontWeight: 600, color: '#665555' }}>启用思考</span>}
                        valuePropName="checked"
                        style={{ marginBottom: 8 }}
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name="thinkingBudget"
                        label={<span style={{ fontWeight: 600, color: '#665555' }}>思考预算 (Tokens)</span>}
                        style={{ marginBottom: 0 }}
                      >
                        <LazySliderInput min={0} max={8192} step={128} />
                      </Form.Item>

                      <Divider style={{ margin: '12px 0' }} />

                      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>图像参数</Text>
                      <Form.Item
                        name="includeImageConfig"
                        label={<span style={{ fontWeight: 600, color: '#665555' }}>启用图像配置</span>}
                        valuePropName="checked"
                        style={{ marginBottom: 8 }}
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        name={['imageConfig', 'imageSize']}
                        label={<span style={{ fontWeight: 600, color: '#665555' }}>分辨率</span>}
                        style={{ marginBottom: 8 }}
                      >
                        <Radio.Group optionType="button" buttonStyle="solid">
                          {IMAGE_SIZE_OPTIONS.map((size) => (
                            <Radio.Button key={size} value={size}>
                              {size}
                            </Radio.Button>
                          ))}
                        </Radio.Group>
                      </Form.Item>
                      <Form.Item
                        name={['imageConfig', 'aspectRatio']}
                        label={<span style={{ fontWeight: 600, color: '#665555' }}>比例</span>}
                        style={{ marginBottom: 8 }}
                      >
                        <Select options={ASPECT_RATIO_OPTIONS.map((value) => ({ value, label: value }))} />
                      </Form.Item>

                      <Form.Item
                        name="webpQuality"
                        label={<span style={{ fontWeight: 600, color: '#665555' }}>WebP 质量</span>}
                        style={{ marginBottom: 8 }}
                      >
                        <LazySliderInput min={50} max={100} step={1} />
                      </Form.Item>

                      <Form.Item
                        name="useResponseModalities"
                        label={<span style={{ fontWeight: 600, color: '#665555' }}>响应模态</span>}
                        valuePropName="checked"
                        extra="TEXT + IMAGE（官方端点可用）"
                        style={{ marginBottom: 0 }}
                      >
                        <Switch />
                      </Form.Item>

                      <Divider style={{ margin: '12px 0' }} />

                      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>安全设置</Text>
                      <Form.Item
                        name="includeSafetySettings"
                        label={<span style={{ fontWeight: 600, color: '#665555' }}>启用安全设置</span>}
                        valuePropName="checked"
                        style={{ marginBottom: 8 }}
                      >
                        <Switch />
                      </Form.Item>
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_HARASSMENT']}
                            label={<span style={{ fontWeight: 600, color: '#665555' }}>骚扰内容</span>}
                            style={{ marginBottom: 8 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_HATE_SPEECH']}
                            label={<span style={{ fontWeight: 600, color: '#665555' }}>仇恨言论</span>}
                            style={{ marginBottom: 8 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_SEXUALLY_EXPLICIT']}
                            label={<span style={{ fontWeight: 600, color: '#665555' }}>色情内容</span>}
                            style={{ marginBottom: 8 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_DANGEROUS_CONTENT']}
                            label={<span style={{ fontWeight: 600, color: '#665555' }}>危险内容</span>}
                            style={{ marginBottom: 8 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item
                            name={['safety', 'HARM_CATEGORY_CIVIC_INTEGRITY']}
                            label={<span style={{ fontWeight: 600, color: '#665555' }}>公民诚信</span>}
                            style={{ marginBottom: 0 }}
                          >
                            <Select options={SAFETY_OPTIONS} />
                          </Form.Item>
                        </Col>
                      </Row>

                      <Divider style={{ margin: '12px 0' }} />

                      <Text style={{ fontWeight: 600, color: '#8B5E34', display: 'block', marginBottom: 8 }}>自定义 JSON</Text>
                      <Form.Item
                        name="customJson"
                        extra="将合并到请求体中（仅 Gemini / Vertex）"
                        style={{ marginBottom: 0 }}
                      >
                        <Input.TextArea rows={4} placeholder='{"generationConfig": {"topK": 40}}' />
                      </Form.Item>
                    </div>
                  ),
                },
              ]}
            />
          );
        }}
      </Form.Item>

      <div style={{ marginTop: 24, padding: 16, background: '#FFF8E1', borderRadius: 16, border: '1px dashed #FFC107' }}>
        <Space align="start">
          <ThunderboltFilled style={{ color: '#FFC107', marginTop: 4, fontSize: 16 }} />
          <Text type="secondary" style={{ fontSize: 13, color: '#8D6E63', lineHeight: 1.5 }}>
            设置将自动应用于所有活动任务窗口。API 配置由管理员统一管理。
          </Text>
        </Space>
      </div>
    </Form>
  </Drawer>
);

export default ConfigDrawer;
