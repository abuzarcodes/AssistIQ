"""Training pipeline for Intent Classification Model."""

import os
import pandas as pd
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score

from app.ml.intent.model import IntentClassifier
from app.core.logging import logger, format_log_context


def train_model() -> None:
    """Train the intent classification model."""
    logger.info("Starting ML model training pipeline")
    
    current_dir = Path(__file__).resolve().parent
    data_path = current_dir / "training_data.csv"
    
    if not data_path.exists():
        logger.error(f"Training data not found at {data_path}")
        return
        
    logger.info(f"Loading dataset from {data_path}")
    df = pd.read_csv(data_path)
    
    if "text" not in df.columns or "label" not in df.columns:
        logger.error("Dataset must contain 'text' and 'label' columns")
        return
        
    df = df.dropna(subset=["text", "label"])
    
    texts = df["text"].tolist()
    labels = df["label"].tolist()
    
    logger.info(f"Loaded {len(texts)} training samples")
    
    # Train/Test Split
    X_train, X_test, y_train, y_test = train_test_split(
        texts, labels, test_size=0.2, random_state=42, stratify=labels
    )
    
    # Train Model
    classifier = IntentClassifier()
    logger.info("Training TF-IDF Vectorizer and Logistic Regression Model...")
    classifier.train(X_train, y_train)
    
    # Evaluate
    X_test_vec = classifier.vectorizer.transform(X_test)
    y_pred = classifier.clf.predict(X_test_vec)
    
    acc = accuracy_score(y_test, y_pred)
    prec = precision_score(y_test, y_pred, average="weighted", zero_division=0)
    rec = recall_score(y_test, y_pred, average="weighted", zero_division=0)
    f1 = f1_score(y_test, y_pred, average="weighted", zero_division=0)
    
    logger.info(
        "Model Evaluation Metrics",
        extra=format_log_context(
            operation="evaluate_model",
            accuracy=round(acc, 4),
            precision=round(prec, 4),
            recall=round(rec, 4),
            f1_score=round(f1, 4),
        ),
    )
    
    print("\n=== Evaluation Metrics ===")
    print(f"Accuracy:  {acc:.4f}")
    print(f"Precision: {prec:.4f}")
    print(f"Recall:    {rec:.4f}")
    print(f"F1 Score:  {f1:.4f}")
    print("==========================\n")
    
    # Save Model
    clf_path, vec_path = classifier.save()
    logger.info(f"Model saved to {clf_path} and {vec_path}")
    print(f"Successfully saved model to:\n- {clf_path}\n- {vec_path}")


if __name__ == "__main__":
    train_model()
