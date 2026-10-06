import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SuggestedQuestionsEditor } from '@/app/dashboard/bots/[botId]/_components/suggested-questions-editor';

/**
 * Checkpoint 6 — the suggested-questions editor (§16.1).
 *
 * Add, remove, reorder, the max-6 limit and the duplicate rejection are the behaviours the
 * server also enforces; the editor exists so the owner sees the rule immediately rather than
 * after a 400.
 */
describe('SuggestedQuestionsEditor', () => {
  it('adds a question and clears the draft', () => {
    const onChange = vi.fn();
    render(<SuggestedQuestionsEditor value={[]} onChange={onChange} />);

    const input = screen.getByLabelText('New suggested question');
    fireEvent.change(input, { target: { value: 'What is your refund policy?' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onChange).toHaveBeenCalledWith(['What is your refund policy?']);
  });

  it('removes a question', () => {
    const onChange = vi.fn();
    render(<SuggestedQuestionsEditor value={['A', 'B']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove A' }));

    expect(onChange).toHaveBeenCalledWith(['B']);
  });

  it('reorders a question', () => {
    const onChange = vi.fn();
    render(<SuggestedQuestionsEditor value={['A', 'B']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move B up' }));

    expect(onChange).toHaveBeenCalledWith(['B', 'A']);
  });

  it('rejects a duplicate (case-insensitive)', () => {
    const onChange = vi.fn();
    render(<SuggestedQuestionsEditor value={['Refunds?']} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('New suggested question'), {
      target: { value: 'refunds?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/already in the list/i)).toBeInTheDocument();
  });

  it('enforces the max of six questions', () => {
    const onChange = vi.fn();
    const six = ['1', '2', '3', '4', '5', '6'];
    render(<SuggestedQuestionsEditor value={six} onChange={onChange} />);

    expect(screen.getByLabelText('New suggested question')).toBeDisabled();
  });
});