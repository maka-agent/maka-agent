import type { Meta, StoryObj } from '@storybook/react-vite';
import type { UserQuestionRequestEvent } from '@maka/core';
import { UserQuestionPrompt } from '@maka/ui';
import { expect, userEvent, within } from 'storybook/test';

import './ask-user-question.css';

const meta = {
  title: 'Product/Ask User Question',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const REQUEST: UserQuestionRequestEvent = {
  type: 'user_question_request',
  id: 'prototype-event',
  ts: Date.now(),
  turnId: 'prototype-turn',
  requestId: 'prototype-request',
  toolUseId: 'prototype-tool',
  questions: [
    {
      question: '首批发布范围选哪个？',
      options: [
        { label: '仅邀请用户', description: '先验证核心流程，再逐步扩大范围。' },
        { label: '公开测试', description: '允许所有访客注册，但保留 Beta 标识。' },
        { label: '正式发布', description: '面向所有访客并启动完整推广。' },
      ],
    },
    { question: '上线时间怎么安排？', options: [{ label: '本周' }, { label: '下周' }] },
    { question: '是否同步发布公告？', options: [{ label: '是' }, { label: '否' }] },
  ],
};

function PreviewColumn(props: {
  title: string;
  width: number;
  request?: UserQuestionRequestEvent;
}) {
  return (
    <div className="maka-question-review-column" style={{ width: props.width }}>
      <p className="maka-question-review-label">{props.title}</p>
      <div className="maka-question-review-chat">
        <div className="maka-question-review-transcript" aria-hidden="true">
          <div><strong>你</strong><p>请帮我确定官网上线方案。</p></div>
          <div><strong>Maka</strong><p>我需要先确认几个有明确选项的发布决策，然后会继续生成执行计划。</p></div>
        </div>
        <UserQuestionPrompt request={props.request ?? REQUEST} onRespond={() => {}} onStop={() => {}} />
      </div>
    </div>
  );
}

export const StandardAndNarrow: Story = {
  render: () => (
    <main className="maka-question-review-board">
      <PreviewColumn title="标准聊天列" width={760} />
      <PreviewColumn title="窄聊天列" width={390} />
    </main>
  ),
};

export const OtherAnswerSelected: Story = {
  render: () => (
    <main className="maka-question-review-board">
      <PreviewColumn
        title="“其他”选中并直接输入"
        width={760}
        request={{ ...REQUEST, questions: REQUEST.questions.slice(0, 1) }}
      />
    </main>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('textbox', { name: '其他答案' });
    await userEvent.click(input);
    await expect(input).toHaveFocus();
    await userEvent.type(input, '分阶段发布');
    await expect(input).toHaveValue('分阶段发布');
    await expect(input.closest('.maka-question-other-field')).toHaveAttribute('data-selected');
  },
};
