import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useRef, useState } from 'react';
import { toStructuredError } from '../services/errors';

export interface AsyncData<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  setData: (value: T | null) => void;
}

export function useAsyncData<T>(loader: () => Promise<T>, dependencies: unknown[]): AsyncData<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const current = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loader();
      if (current === requestId.current) {
        setData(result);
      }
    } catch (caught) {
      if (current === requestId.current) {
        setError(toStructuredError(caught).message);
      }
    } finally {
      if (current === requestId.current) {
        setLoading(false);
      }
    }
  }, dependencies);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );

  return { data, loading, error, reload, setData };
}
