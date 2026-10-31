import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Reviews } from './Reviews';

afterEach(cleanup);

describe('Reviews star rating', () => {
  it('starts at 5 stars with the matching label', () => {
    render(<Reviews />);
    expect(screen.getByLabelText('5 stars').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Excellent', { exact: false })).toBeTruthy();
  });
  it('hovering only previews a rating; clicking selects it', () => {
    render(<Reviews />);
    fireEvent.mouseEnter(screen.getByLabelText('2 stars'));
    expect(screen.getByText('Fair', { exact: false })).toBeTruthy();
    fireEvent.mouseLeave(screen.getByRole('radiogroup'));
    expect(screen.getByText('Excellent', { exact: false })).toBeTruthy();   // preview gone, rating unchanged
    fireEvent.click(screen.getByLabelText('4 stars'));
    expect(screen.getByLabelText('4 stars').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('5 stars').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Very good', { exact: false })).toBeTruthy();
  });
});
