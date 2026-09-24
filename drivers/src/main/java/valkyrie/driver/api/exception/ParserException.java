package valkyrie.driver.api.exception;

import valkyrie.utils.exception.SystemRuntimeException;

/**
 * @author Luo Tiansheng
 * @since 2026/6/12
 */
public class ParserException extends SystemRuntimeException
{
        public ParserException()
        {
        }

        public ParserException(Throwable e)
        {
                super(e);
        }

        public ParserException(String fmt, Object... args)
        {
                super(fmt, args);
        }

        public ParserException(String fmt, Throwable e, Object... args)
        {
                super(fmt, e, args);
        }
}
