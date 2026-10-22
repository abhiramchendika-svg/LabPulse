import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { useDocumentTitle } from '../lib/hooks';

const SAMPLE_RUN = {
  exerciseId: 'receipt-line',
  result: 'error',
  testsPassed: 0,
  testsTotal: 3,
  errorType: 'TypeError',
  errorMessage: "unsupported operand type(s) for +: 'int' and 'str'",
  failingTest: 'test_several_items',
};

const SAMPLE_ACTIVITY = { exerciseId: 'receipt-line' };

export function PrivacyPage() {
  useDocumentTitle('What gets shared');
  return (
    <div className="privacy">
      <header className="home-top">
        <Logo />
      </header>
      <main className="privacy-main">
        <h1>What LabPulse shares with your instructor</h1>
        <p className="privacy-lede">
          Your tests run inside your own browser. LabPulse sends your instructor just enough to see who is stuck and on what,
          so they can help everyone with the same problem at once.
        </p>

        <div className="privacy-cols">
          <section className="privacy-col" data-tone="sent">
            <h2>Sent</h2>
            <ul>
              <li>The name you typed when you joined</li>
              <li>Each time you run the tests: which exercise, how many tests passed, the first test that failed, and the type of error</li>
              <li>The error message with variable names, values, file paths and line numbers removed</li>
              <li>Which exercise you're working on, about every 30 seconds while you type</li>
            </ul>
          </section>
          <section className="privacy-col" data-tone="kept">
            <h2>Never sent</h2>
            <ul>
              <li>Your code</li>
              <li>Your keystrokes</li>
              <li>What your program prints</li>
              <li>Anything from other tabs or files on your laptop</li>
            </ul>
          </section>
        </div>

        <section className="privacy-sample">
          <h2>A real example</h2>
          <p>
            Your code tried to add a number to some text. This is everything sent after that run. The message mentions only the
            types <code>int</code> and <code>str</code>, not your variables or values.
          </p>
          <pre>{JSON.stringify(SAMPLE_RUN, null, 2)}</pre>
          <p>While you're typing, this is all that's sent:</p>
          <pre>{JSON.stringify(SAMPLE_ACTIVITY, null, 2)}</pre>
          <p>
            During a lab, open <strong>What's shared</strong> at the top of the editor to see the exact messages your browser
            has sent.
          </p>
        </section>

        <section className="privacy-sample">
          <h2>On the big screen</h2>
          <p>
            Instructors can switch on <strong>Hide names</strong> before putting the dashboard on a projector. Names are
            replaced with numbers, both on the dashboard and in the report.
          </p>
        </section>

        <Link to="/" className="btn">
          Back to joining a lab
        </Link>
      </main>
    </div>
  );
}
